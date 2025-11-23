// src/types/order.ts

export interface OrderRow {
  id: number;
  file_order_id: string;
  external_order_id: string | null;
  order_channel: string;
  store_code: string;
  seller_id: string | null;
  created_date: Date;
  email: string | null;
  firstname: string | null;
  lastname: string | null;
  country_id: string | null;
  region_id: string | null;
  region: string | null;
  postcode: string | null;
  street: string | null;
  city: string | null;
  telephone: string | null;
  company: string | null;
  fax: string | null;
  taxvat: string | null;
  cnpj: string | null;
  shipping_method: string | null;
  delivery_instructions: string | null;
  coupon_code: string | null;

  magento_order_id: number | null;
  magento_increment_id: string | null;

  status: string;
  last_error: string | null;

  // audit / workflow fields
  imported_by: string | null;
  invoiced_at: Date | null;
  shipped_at: Date | null;
  magento_invoice_id: number | null;
  magento_shipment_id: number | null;

  created_at: Date;
  updated_at: Date;
}

export interface OrderItemRow {
  id: number;
  order_id: number;
  sku: string;
  name: string | null;
  qty_ordered: number;
  price: number;
  original_price: number | null;
}

export type JobStatus = 'PENDING' | 'RUNNING' | 'RETRY' | 'FAILED' | 'DONE';

export interface JobRow {
  id: number;
  type: string;
  payload: any; // parsed JSON
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_run_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChannelRuleRow {
  id: number;
  channel: string;
  auto_invoice: number; // tinyint
  auto_ship: number;
  is_active: number;
  created_at: Date;
  updated_at: Date;
}
