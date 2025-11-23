import { db } from '../knex';
import { OrderRow } from '../../types/order';

interface UpsertOrderInput {
  file_order_id: string;
  external_order_id?: string | null;
  order_channel: string;
  store_code: string;
  seller_id?: string | null;
  created_date: Date;
  email?: string | null;
  firstname?: string | null;
  lastname?: string | null;
  country_id?: string | null;
  region_id?: string | null;
  region?: string | null;
  postcode?: string | null;
  street?: string | null;
  city?: string | null;
  telephone?: string | null;
  company?: string | null;
  fax?: string | null;
  taxvat?: string | null;
  cnpj?: string | null;
  shipping_method?: string | null;
  delivery_instructions?: string | null;
  coupon_code?: string | null;
  imported_by?: string | null; // 
  import_job_id?: number | null;
}

export async function upsertOrder(header: UpsertOrderInput): Promise<number> {
  // Always fall back to file_order_id
  const externalOrderId =
    header.external_order_id === undefined || header.external_order_id === null
      ? header.file_order_id
      : header.external_order_id;

  // Ensure channel is never undefined
  const channel = (header.order_channel || 'UNKNOWN').toString();

  console.log(
    'UPSERT ORDER DEBUG:',
    'file_order_id=',
    header.file_order_id,
    'external_order_id=',
    externalOrderId,
    'order_channel=',
    channel
  );

  // 1) Check if it already exists
  const existing = await db<OrderRow>('orders')
    .where({
      external_order_id: externalOrderId,
      order_channel: channel
    })
    .first();

  const baseUpdate = {
    ...header,
    external_order_id: externalOrderId,
    order_channel: channel,
    imported_by: header.imported_by ?? null
  };

  if (existing) {
    await db('orders')
      .where({ id: existing.id })
      .update({
        ...baseUpdate,
        updated_at: db.fn.now()
      });

    return existing.id;
  }

  // 2) Insert new
  const insertResult = await db('orders').insert(baseUpdate);

  // MariaDB returns [insertId]
  const insertId = Array.isArray(insertResult)
    ? (insertResult[0] as number)
    : (insertResult as unknown as number);

  return insertId;
}

export async function getOrderById(id: number): Promise<OrderRow | undefined> {
  return db<OrderRow>('orders').where({ id }).first();
}

export async function setMagentoIds(
  orderId: number,
  magentoOrderId: number,
  magentoIncrementId?: string | null
): Promise<void> {
  await db('orders')
    .where({ id: orderId })
    .update({
      magento_order_id: magentoOrderId,
      magento_increment_id: magentoIncrementId ?? null,
      updated_at: db.fn.now()
    });
}

export async function updateOrderStatus(
  orderId: number,
  status: string,
  lastError?: string | null
): Promise<void> {
  await db('orders')
    .where({ id: orderId })
    .update({
      status,
      last_error: lastError ?? null,
      updated_at: db.fn.now()
    });
}
export async function markOrderInvoiced(
  orderId: number,
  magentoInvoiceId: number | null
): Promise<void> {
  await db('orders')
    .where({ id: orderId })
    .update({
      magento_invoice_id: magentoInvoiceId,
      invoiced_at: db.fn.now(),
      updated_at: db.fn.now()
    });
}

export async function markOrderShipped(
  orderId: number,
  magentoShipmentId: number | null
): Promise<void> {
  await db('orders')
    .where({ id: orderId })
    .update({
      magento_shipment_id: magentoShipmentId,
      shipped_at: db.fn.now(),
      updated_at: db.fn.now()
    });
}
