export type RawOrderHeaderRow = Record<string, string | undefined>;
export type RawOrderItemRow = Record<string, string | undefined>;

export interface ParsedOrderHeader {
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
}

export interface ParsedOrderItem {
  file_order_id: string;
  sku: string;
  name: string | null;
  qty_ordered: number;
  price: number;
  original_price: number | null;
}

export interface ImportSummary {
  totalOrders: number;
  processedOrders: number;
  skippedOrders: number;
  failedOrders: number;
}

export interface FailedOrderInfo {
  file_order_id: string;
  order_channel: string;
  error: string;
}
