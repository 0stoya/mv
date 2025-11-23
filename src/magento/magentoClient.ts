import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { logError } from '../utils/logger';

export interface MagentoCartItemInput {
  sku: string;
  qty: number;
}
export interface MagentoOrder {
  entity_id: number;
  increment_id: string;
  status: string;
}

export class MagentoClient {
  private client: AxiosInstance;
  private storeCode: string;
  private freeShippingMethod: string;
  private codMethod: string;

  constructor() {
    const baseUrl = process.env.MAGENTO_BASE_URL;
    const token = process.env.MAGENTO_API_TOKEN;

    this.storeCode = process.env.MAGENTO_STORE_CODE || 'default';
    this.freeShippingMethod = process.env.MAGENTO_FREE_SHIPPING_METHOD || 'freeshipping';
    this.codMethod = process.env.MAGENTO_COD_METHOD || 'cashondelivery';

    if (!baseUrl) throw new Error('MAGENTO_BASE_URL is not configured');
    if (!token) throw new Error('MAGENTO_API_TOKEN is not configured');

    // OPTIMIZATION: Keep-Alive Agents
    // This prevents re-negotiating SSL for every single step of the order placement
    const httpAgent = new http.Agent({ keepAlive: true });
    const httpsAgent = new https.Agent({ keepAlive: true });

    this.client = axios.create({
      baseURL: `${baseUrl}/${this.storeCode}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000,
      httpAgent,
      httpsAgent
    });
  }

  private async request<T>(ctx: string, config: any): Promise<T> {
    try {
      const res = await this.client.request<T>(config);
      return res.data;
    } catch (err: any) {
      if (err?.response) {
        logError(ctx, `Magento ${config.method} ${config.url} error`, {
          url: config.url,
          status: err.response.status,
          data: err.response.data
        });
      } else {
        logError(ctx, `Magento ${config.method} ${config.url} error`, {
          message: err?.message || String(err)
        });
      }
      throw err;
    }
  }

  //─────────────────────────────────────────
  // CART
  //─────────────────────────────────────────

  async createGuestCart(): Promise<string> {
    const ctx = 'magento:createGuestCart';
    return this.request<string>(ctx, { method: 'POST', url: '/V1/guest-carts' });
  }

  async addItemToGuestCart(cartId: string, item: MagentoCartItemInput): Promise<void> {
    const ctx = 'magento:addItemToGuestCart';
    await this.request(ctx, {
      method: 'POST',
      url: `/V1/guest-carts/${encodeURIComponent(cartId)}/items`,
      data: {
        cartItem: {
          quote_id: cartId,
          sku: item.sku,
          qty: item.qty
        }
      }
    });
  }

  async setGuestCartAddresses(cartId: string, order: any): Promise<void> {
    const ctx = 'magento:setGuestCartAddresses';

    const streetLines = String(order.street || '')
      .split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);

    const hasRegionId = order.region_id && String(order.region_id).trim() !== '';
    const hasRegionName = order.region && String(order.region).trim() !== '';

    // Region Mapping Logic (Argentina/UK/etc)
    const regionMap: Record<string, { code: string; name: string }> = {
      '714': { code: 'CABA', name: 'Ciudad Autónoma de Buenos Aires' },
      '715': { code: 'BA', name: 'Buenos Aires' }
    };

    const address: any = {
      email: order.email || 'guest@example.com',
      firstname: order.firstname || 'Guest',
      lastname: order.lastname || 'Guest',
      telephone: order.telephone || '0000000000',
      countryId: order.country_id || 'GB',
      postcode: order.postcode || '',
      city: order.city || '',
      street: streetLines.length ? streetLines : [''],
      company: order.company || undefined
    };

    if (hasRegionId || hasRegionName) {
      let regionName = hasRegionName ? String(order.region).trim() : '';
      let regionId: number | undefined;
      let regionCode: string | undefined;

      if (hasRegionId) {
        const key = String(order.region_id).trim();
        const meta = regionMap[key];
        if (meta) {
          regionName = meta.name;
          regionCode = meta.code;
        }
        regionId = Number(order.region_id);
      }

      if (regionName) address.region = regionName;
      if (regionId !== undefined) address.region_id = regionId;
      if (regionCode) address.region_code = regionCode;
    }

    await this.request(ctx, {
      method: 'POST',
      url: `/V1/guest-carts/${encodeURIComponent(cartId)}/shipping-information`,
      data: {
        addressInformation: {
          shipping_address: address,
          billing_address: address,
          shipping_carrier_code: 'freeshipping',
          shipping_method_code: this.freeShippingMethod
        }
      }
    });
  }

  async setPaymentMethodCOD(cartId: string): Promise<void> {
    const ctx = 'magento:setPaymentMethodCOD';
    await this.request(ctx, {
      method: 'PUT',
      url: `/V1/guest-carts/${encodeURIComponent(cartId)}/selected-payment-method`,
      data: { method: { method: this.codMethod } }
    });
  }

  async placeGuestOrder(cartId: string): Promise<number> {
    const ctx = 'magento:placeGuestOrder';
    // Optimization: Increased timeout for order placement as it's the heaviest operation
    return this.request<number>(ctx, {
      method: 'PUT',
      url: `/V1/guest-carts/${encodeURIComponent(cartId)}/order`,
      timeout: 60000 
    });
  }

  //─────────────────────────────────────────
  // ORDER COMMENT
  //─────────────────────────────────────────

  async addOrderComment(orderId: number, comment: string): Promise<void> {
    const ctx = 'magento:addOrderComment';
    await this.request(ctx, {
      method: 'POST',
      url: `/V1/orders/${orderId}/comments`,
      data: {
        statusHistory: {
          comment,
          status: 'pending',
          is_customer_notified: 0,
          is_visible_on_front: 0
        }
      }
    });
  }

  //─────────────────────────────────────────
  // INVOICE / SHIPMENT (AUTO ACTIONS)
  //─────────────────────────────────────────

  async createInvoice(orderId: number): Promise<number> {
    const ctx = 'magento:createInvoice';
    return this.request<number>(ctx, {
      method: 'POST',
      url: `/V1/order/${orderId}/invoice`,
      data: { capture: true }
    });
  }

  async createShipment(orderId: number): Promise<number> {
    const ctx = 'magento:createShipment';
    return this.request<number>(ctx, {
      method: 'POST',
      url: `/V1/order/${orderId}/ship`,
      data: {}
    });
  }

  //─────────────────────────────────────────
  // OSTOYA ORDER / CUSTOMER BACKDATING
  //─────────────────────────────────────────

  async backdateOrder(orderId: number, createdAt: string): Promise<void> {
    const ctx = 'magento:backdateOrder';
    await this.request(ctx, {
      method: 'POST',
      url: `/V1/ostoya/orders/${orderId}/backdate`,
      data: { orderId, createdAt }
    });
  }

  async attachCustomerAndBackdate(
    orderId: number,
    email: string,
    firstname: string,
    lastname: string,
    createdAt?: string | null
  ): Promise<void> {
    const ctx = 'magento:attachCustomerAndBackdate';
    await this.request(ctx, {
      method: 'POST',
      url: `/V1/ostoya/orders/${orderId}/attach-customer`,
      data: { orderId, email, firstname, lastname, createdAt: createdAt ?? null }
    });
  }

  async backdateInvoice(invoiceId: number | string, createdAt: string): Promise<void> {
    const ctx = 'magento:backdateInvoice';
    await this.request(ctx, {
      method: 'POST',
      url: `/V1/ostoya/invoices/${invoiceId}/backdate`,
      data: { invoiceId, createdAt }
    });
  }

  async backdateShipment(shipmentId: number | string, createdAt: string): Promise<void> {
    const ctx = 'magento:backdateShipment';
    await this.request(ctx, {
      method: 'POST',
      url: `/V1/ostoya/shipments/${shipmentId}/backdate`,
      data: { shipmentId, createdAt }
    });
  }

  async getOrderById(orderId: number): Promise<MagentoOrder> {
    const ctx = 'magento:getOrderById';
    return this.request<MagentoOrder>(ctx, {
      method: 'GET',
      url: `/V1/orders/${orderId}`
    });
  }
}

export const magentoClient = new MagentoClient();
export default magentoClient;
