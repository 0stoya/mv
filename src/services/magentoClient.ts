import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { logInfo, logMagentoError } from '../utils/logger';

export interface MagentoClientOptions {
  baseUrl: string;
  storeCode?: string;
  token: string;
  freeShippingMethod?: string;
  codMethod?: string;
}

export class MagentoClient {
  private client: AxiosInstance;
  private storePath: string;
  private freeShippingMethod: string;
  private codMethod: string;

  constructor(opts: MagentoClientOptions) {
    const { baseUrl, storeCode, token } = opts;

    this.storePath = storeCode ? `/rest/${storeCode}` : '/rest/default';
    this.freeShippingMethod = opts.freeShippingMethod || 'freeshipping';
    this.codMethod = opts.codMethod || 'cashondelivery';

    this.client = axios.create({
      baseURL: baseUrl.replace(/\/+$/, ''),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      timeout: 60000
    });
  }

  private async request<T = any>(
    ctx: string,
    config: AxiosRequestConfig
  ): Promise<T> {
    try {
      const res = await this.client.request<T>(config);
      return res.data;
    } catch (err: any) {
      if (err?.response) {
        logMagentoError(ctx, err);
      }
      throw err;
    }
  }

  async createGuestCart(): Promise<string> {
    const ctx = 'magento:createGuestCart';

    const cartId = await this.request<string>(ctx, {
      method: 'POST',
      url: `${this.storePath}/V1/guest-carts`
    });

    logInfo(ctx, 'Created guest cart', { cartId });
    return cartId;
  }

  async addItemToGuestCart(
    cartId: string,
    sku: string,
    qty: number
  ): Promise<void> {
    const ctx = 'magento:addItemToGuestCart';

    await this.request(ctx, {
      method: 'POST',
      url: `${this.storePath}/V1/guest-carts/${encodeURIComponent(
        cartId
      )}/items`,
      data: {
        cartItem: {
          quote_id: cartId,
          sku,
          qty
        }
      }
    });
  }

  /**
   * Sets shipping + billing addresses AND shipping method.
   * If region/region_id are empty in the order, they are not sent at all.
   */
  async setGuestCartAddresses(
    cartId: string,
    order: any
  ): Promise<void> {
    const ctx = 'magento:setGuestCartAddresses';

    const streetLines = String(order.street || '')
      .split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l !== '');

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

    const regionValue = (order.region ?? '').toString().trim();
    const regionIdValue = (order.region_id ?? '').toString().trim();

    if (regionValue) {
      address.region = regionValue;
    }
    if (regionIdValue) {
      const numericRegionId = Number(regionIdValue);
      if (!Number.isNaN(numericRegionId)) {
        address.region_id = numericRegionId;
      }
    }

    await this.request(ctx, {
      method: 'POST',
      url: `${this.storePath}/V1/guest-carts/${encodeURIComponent(
        cartId
      )}/shipping-information`,
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

  async setGuestCartPaymentMethod(cartId: string): Promise<void> {
    const ctx = 'magento:setGuestCartPaymentMethod';

    await this.request(ctx, {
      method: 'PUT',
      url: `${this.storePath}/V1/guest-carts/${encodeURIComponent(
        cartId
      )}/selected-payment-method`,
      data: {
        method: this.codMethod
      }
    });
  }

  async placeGuestCartOrder(cartId: string): Promise<number> {
    const ctx = 'magento:placeGuestCartOrder';

    const orderId = await this.request<number>(ctx, {
      method: 'PUT',
      url: `${this.storePath}/V1/guest-carts/${encodeURIComponent(
        cartId
      )}/order`
    });

    logInfo(ctx, 'Placed order from guest cart', {
      cartId,
      orderId
    });

    return orderId;
  }

  async addOrderComment(orderId: number, comment: string): Promise<void> {
  const ctx = 'magento:addOrderComment';

  await this.request(ctx, {
    method: 'POST',
    url: `/V1/orders/${orderId}/comments`,
    data: {
      statusHistory: {
        comment
      }
    }
  });
}
}

// Singleton instance used by workers
export const magentoClient = new MagentoClient({
  baseUrl: process.env.MAGENTO_BASE_URL || '',
  storeCode: process.env.MAGENTO_STORE_CODE || 'default',
  token: process.env.MAGENTO_API_TOKEN || '',
  freeShippingMethod:
    process.env.MAGENTO_FREESHIPPING_METHOD || 'freeshipping',
  codMethod: process.env.MAGENTO_COD_METHOD || 'cashondelivery'
});

export default magentoClient;
