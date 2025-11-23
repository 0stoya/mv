"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.magentoClient = exports.MagentoClient = void 0;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../utils/logger");
class MagentoClient {
    constructor(opts) {
        const { baseUrl, storeCode, token } = opts;
        this.storePath = storeCode ? `/rest/${storeCode}` : '/rest/default';
        this.freeShippingMethod = opts.freeShippingMethod || 'freeshipping';
        this.codMethod = opts.codMethod || 'cashondelivery';
        this.client = axios_1.default.create({
            baseURL: baseUrl.replace(/\/+$/, ''),
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            timeout: 60000
        });
    }
    async request(ctx, config) {
        try {
            const res = await this.client.request(config);
            return res.data;
        }
        catch (err) {
            if (err?.response) {
                (0, logger_1.logMagentoError)(ctx, err);
            }
            throw err;
        }
    }
    async createGuestCart() {
        const ctx = 'magento:createGuestCart';
        const cartId = await this.request(ctx, {
            method: 'POST',
            url: `${this.storePath}/V1/guest-carts`
        });
        (0, logger_1.logInfo)(ctx, 'Created guest cart', { cartId });
        return cartId;
    }
    async addItemToGuestCart(cartId, sku, qty) {
        const ctx = 'magento:addItemToGuestCart';
        await this.request(ctx, {
            method: 'POST',
            url: `${this.storePath}/V1/guest-carts/${encodeURIComponent(cartId)}/items`,
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
    async setGuestCartAddresses(cartId, order) {
        const ctx = 'magento:setGuestCartAddresses';
        const streetLines = String(order.street || '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== '');
        const address = {
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
            url: `${this.storePath}/V1/guest-carts/${encodeURIComponent(cartId)}/shipping-information`,
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
    async setGuestCartPaymentMethod(cartId) {
        const ctx = 'magento:setGuestCartPaymentMethod';
        await this.request(ctx, {
            method: 'PUT',
            url: `${this.storePath}/V1/guest-carts/${encodeURIComponent(cartId)}/selected-payment-method`,
            data: {
                method: this.codMethod
            }
        });
    }
    async placeGuestCartOrder(cartId) {
        const ctx = 'magento:placeGuestCartOrder';
        const orderId = await this.request(ctx, {
            method: 'PUT',
            url: `${this.storePath}/V1/guest-carts/${encodeURIComponent(cartId)}/order`
        });
        (0, logger_1.logInfo)(ctx, 'Placed order from guest cart', {
            cartId,
            orderId
        });
        return orderId;
    }
    async addOrderComment(orderId, comment) {
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
exports.MagentoClient = MagentoClient;
// Singleton instance used by workers
exports.magentoClient = new MagentoClient({
    baseUrl: process.env.MAGENTO_BASE_URL || '',
    storeCode: process.env.MAGENTO_STORE_CODE || 'default',
    token: process.env.MAGENTO_API_TOKEN || '',
    freeShippingMethod: process.env.MAGENTO_FREESHIPPING_METHOD || 'freeshipping',
    codMethod: process.env.MAGENTO_COD_METHOD || 'cashondelivery'
});
exports.default = exports.magentoClient;
