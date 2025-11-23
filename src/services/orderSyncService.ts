import { db } from '../db/knex';
import magentoClient from '../magento/magentoClient';
import { createChildContextId, logInfo, logError } from '../utils/logger';
import { resolveChannelRule } from './channelRuleService';
import {
  markOrderInvoiced,
  markOrderShipped
} from '../db/repositories/ordersRepository';
import {
  createInvoiceJobIfNotExists,
  createShipJobIfNotExists
} from './jobsService';
import { addMinutes, formatToMySqlDateTime } from '../utils/dateUtils';
import { OrderRow, OrderItemRow } from '../types/order';

/**
 * SYNC_ORDER_TO_MAGENTO
 *
 * - Creates Magento guest cart
 * - Adds items
 * - Sets addresses + payment
 * - Places order
 * - Backdates + attaches customer
 * - Adds "Bulk Import" comment
 * - Schedules INVOICE job (if channelRule.autoInvoice)
 *   (Shipping is now scheduled AFTER invoice succeeds)
 */
export async function syncOrderById(
  orderId: number,
  parentCtx = 'worker'
): Promise<void> {
  const ctx = createChildContextId(parentCtx, `order:${orderId}`);

  try {
    const order = await db<OrderRow>('orders').where({ id: orderId }).first();
    if (!order) {
      logError(ctx, 'Order not found in DB', { orderId });
      throw new Error(`Order ${orderId} not found`);
    }

    const items = await db<OrderItemRow>('order_items').where({
      order_id: orderId
    });

    // If already synced (magento_order_id exists), don't try to create again.
    if (order.magento_order_id) {
      logInfo(ctx, 'Order already has magento_order_id, skipping creation', {
        magento_order_id: order.magento_order_id
      });
      return;
    }

    const magento = magentoClient;

    // 1. Create guest cart
    logInfo(ctx, 'Creating guest cart', {
      external_order_id: order.external_order_id,
      order_channel: order.order_channel
    });

    const cartId = await magento.createGuestCart();

    // 2. Add items (with limited concurrency)
    if (items.length) {
      const maxItemConcurrency = Number(
        process.env.ITEM_CONCURRENCY || '4'
      );

      const queue = [...items];
      const workers: Promise<void>[] = [];
      const workerCount = Math.min(maxItemConcurrency, queue.length);

      for (let i = 0; i < workerCount; i++) {
        workers.push(
          (async () => {
            while (true) {
              const item = queue.shift();
              if (!item) return;

              logInfo(ctx, 'Adding item to cart', {
                cartId,
                sku: item.sku,
                qty: item.qty_ordered
              });

              await magento.addItemToGuestCart(cartId, {
                sku: item.sku,
                qty: Number(item.qty_ordered)
              });
            }
          })()
        );
      }

      await Promise.all(workers);
    } else {
      logInfo(ctx, 'Order has no items, continuing anyway', { orderId });
    }

    // 3. Address + shipping
    logInfo(ctx, 'Setting addresses and shipping', { cartId });
    await magento.setGuestCartAddresses(cartId, order);

    // 4. Payment method (COD)
    logInfo(ctx, 'Setting payment method COD', { cartId });
    await magento.setPaymentMethodCOD(cartId);

    // 5. Place order
    const magentoOrderId = await magento.placeGuestOrder(cartId);
    logInfo(ctx, 'Magento order placed', { magentoOrderId });

    // Fetch full order to get increment_id (non-fatal if it fails)
    let magentoIncrementId: string | null = null;

    try {
      const magentoOrder = await magento.getOrderById(magentoOrderId);
      magentoIncrementId = magentoOrder.increment_id?.toString() ?? null;

      logInfo(ctx, 'Fetched Magento increment_id', {
        magentoOrderId,
        magentoIncrementId
      });
    } catch (err: any) {
      logError(ctx, 'Failed to fetch Magento increment_id (non-fatal)', {
        magentoOrderId,
        error: err?.message || String(err)
      });
    }

    // 6. Save to DB (status SYNCED, magento_order_id set)
    await db('orders')
      .where({ id: orderId })
      .update({
        status: 'SYNCED',
        magento_order_id: magentoOrderId,
        magento_increment_id: magentoIncrementId,
        updated_at: db.fn.now()
      });

    // 7. Backdate + convert to customer (via Ostoya_OrderTools)
    try {
      const createdAt = formatToMySqlDateTime(order.created_date);

      if (order.email) {
        await magento.attachCustomerAndBackdate(
          magentoOrderId,
          order.email,
          order.firstname || 'Guest',
          order.lastname || 'Guest',
          createdAt
        );

        logInfo(ctx, 'Attached customer and backdated order in Magento', {
          magentoOrderId,
          email: order.email,
          createdAt
        });
      } else {
        await magento.backdateOrder(magentoOrderId, createdAt);

        logInfo(ctx, 'Backdated guest order in Magento', {
          magentoOrderId,
          createdAt
        });
      }
    } catch (err: any) {
      // Non-fatal: order is already created and stored; this just affects metadata
      logError(ctx, 'Failed to attach customer / backdate order (non-fatal)', {
        magentoOrderId,
        error: err?.message || String(err)
      });
    }

    // 8. Add Magento comment (non-fatal)
    const comment = [
      'Order Created via Bulk Import',
      `Import order id: ${order.file_order_id}`,
      `Imported by: ${order.imported_by || 'System'}`,
      `Original created date: ${order.created_date}`
    ].join('\n');

    try {
      await magento.addOrderComment(magentoOrderId, comment);
      logInfo(ctx, 'Added Magento order comment', { magentoOrderId });
    } catch (err: any) {
      logError(ctx, 'Failed to add Magento order comment (non-fatal)', {
        magentoOrderId,
        error: err?.message || String(err)
      });
    }

    // 9. Channel rules: schedule invoice (shipping is scheduled after invoice)
    const channelRule = await resolveChannelRule(order.order_channel);

    if (channelRule.autoInvoice) {
      await createInvoiceJobIfNotExists(order.id);
      logInfo(ctx, 'Scheduled invoice job', {
        orderId,
        magentoOrderId,
        channel: order.order_channel
      });
    }

    // If someone misconfigures autoShip=true, autoInvoice=false, warn in logs
    if (channelRule.autoShip && !channelRule.autoInvoice) {
      logError(ctx, 'Channel rule has autoShip=true but autoInvoice=false; shipping will never auto-run', {
        channel: order.order_channel
      });
    }

  } catch (err: any) {
    logError(ctx, 'Failed to sync order', {
      error: err?.message || String(err)
    });
    throw err;
  }
}

/**
 * INVOICE_MAGENTO_ORDER
 *
 * - Creates invoice in Magento
 * - Backdates invoice
 * - Marks order.invoiced_at
 * - Then, if channelRule.autoShip === true, schedules SHIP_MAGENTO_ORDER
 */
export async function invoiceOrderById(
  orderId: number,
  parentCtx = 'worker'
): Promise<void> {
  const ctx = createChildContextId(parentCtx, `invoice:${orderId}`);

  const order = await db<OrderRow>('orders').where({ id: orderId }).first();
  if (!order) {
    logError(ctx, 'Order not found in DB for invoice', { orderId });
    throw new Error(`Order ${orderId} not found`);
  }

  if (!order.magento_order_id) {
    logError(ctx, 'Cannot invoice order without magento_order_id', {
      orderId
    });
    throw new Error('Order has no magento_order_id');
  }

  if (order.invoiced_at) {
    logInfo(ctx, 'Order already invoiced, skipping', {
      orderId,
      magento_order_id: order.magento_order_id,
      invoiced_at: order.invoiced_at
    });
    return;
  }

  const magento = magentoClient;

  // 1) Create invoice in Magento
  const invoiceId = await magento.createInvoice(order.magento_order_id);

  // 2) Compute backdated invoice time: 10 minutes after order.created_date
  const invoiceDate = addMinutes(order.created_date, 10);
  const invoiceCreatedAt = formatToMySqlDateTime(invoiceDate);

  // 3) Backdate invoice in Magento (non-fatal if it fails)
  try {
    await magento.backdateInvoice(invoiceId, invoiceCreatedAt);
    logInfo(ctx, 'Backdated invoice in Magento', {
      orderId,
      invoiceId,
      invoiceCreatedAt
    });
  } catch (err: any) {
    logError(ctx, 'Failed to backdate invoice (non-fatal)', {
      orderId,
      invoiceId,
      error: err?.message || String(err)
    });
  }

  // 4) Persist invoiced_at
  await markOrderInvoiced(orderId, invoiceId);

  logInfo(ctx, 'Invoice created and recorded', {
    orderId,
    invoiceId
  });

  // 5) After successful invoice, decide whether to auto-schedule shipping
  try {
    const refreshedOrder = await db<OrderRow>('orders')
      .where({ id: orderId })
      .first();

    if (!refreshedOrder) {
      logError(ctx, 'Order disappeared after invoicing (unexpected)', {
        orderId
      });
      return;
    }

    const channelRule = await resolveChannelRule(refreshedOrder.order_channel);

    if (channelRule.autoShip) {
      await createShipJobIfNotExists(orderId);
      logInfo(ctx, 'Scheduled ship job after invoice', {
        orderId,
        magento_order_id: refreshedOrder.magento_order_id,
        channel: refreshedOrder.order_channel
      });
    }
  } catch (err: any) {
    // Non-fatal: invoice is still created; just no auto-shipping
    logError(ctx, 'Failed to schedule ship job after invoice (non-fatal)', {
      orderId,
      error: err?.message || String(err)
    });
  }
}

/**
 * SHIP_MAGENTO_ORDER
 *
 * - Creates shipment in Magento
 * - Backdates shipment
 * - Marks order.shipped_at
 */
export async function shipOrderById(
  orderId: number,
  parentCtx = 'worker'
): Promise<void> {
  const ctx = createChildContextId(parentCtx, `ship:${orderId}`);

  const order = await db<OrderRow>('orders').where({ id: orderId }).first();
  if (!order) {
    logError(ctx, 'Order not found in DB for shipment', { orderId });
    throw new Error(`Order ${orderId} not found`);
  }

  if (!order.magento_order_id) {
    logError(ctx, 'Cannot ship order without magento_order_id', {
      orderId
    });
    throw new Error('Order has no magento_order_id');
  }

  if (order.shipped_at) {
    logInfo(ctx, 'Order already shipped, skipping', {
      orderId,
      magento_order_id: order.magento_order_id,
      shipped_at: order.shipped_at
    });
    return;
  }

  const magento = magentoClient;

  // 1) Create shipment in Magento
  const shipmentId = await magento.createShipment(order.magento_order_id);

  // 2) Compute backdated shipment time: order.created_date + 20 minutes
  const shipmentDate = addMinutes(order.created_date, 20);
  const shipmentCreatedAt = formatToMySqlDateTime(shipmentDate);

  // 3) Backdate shipment in Magento (non-fatal if it fails)
  try {
    await magento.backdateShipment(shipmentId, shipmentCreatedAt);
    logInfo(ctx, 'Backdated shipment in Magento', {
      orderId,
      shipmentId,
      shipmentCreatedAt
    });
  } catch (err: any) {
    logError(ctx, 'Failed to backdate shipment (non-fatal)', {
      orderId,
      shipmentId,
      error: err?.message || String(err)
    });
  }

  // 4) Persist shipped_at
  await markOrderShipped(orderId, shipmentId);

  logInfo(ctx, 'Shipment created and recorded', {
    orderId,
    shipmentId
  });
}
