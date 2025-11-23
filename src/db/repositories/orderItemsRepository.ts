import { db } from '../knex';
import { OrderItemRow } from '../../types/order';

interface NewItem {
  sku: string;
  name?: string | null;
  qty_ordered: number;
  price: number;
  original_price?: number | null;
}

export async function replaceOrderItems(
  orderId: number,
  items: NewItem[]
): Promise<void> {
  await db('order_items').where({ order_id: orderId }).del();

  if (!items.length) return;

  await db('order_items').insert(
    items.map((item) => ({
      order_id: orderId,
      sku: item.sku,
      name: item.name ?? null,
      qty_ordered: item.qty_ordered,
      price: item.price,
      original_price: item.original_price ?? null
    }))
  );
}

export async function getOrderItems(orderId: number): Promise<OrderItemRow[]> {
  return db<OrderItemRow>('order_items').where({ order_id: orderId });
}
