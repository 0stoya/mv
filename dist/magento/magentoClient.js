"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.magentoClient = exports.MagentoClient = void 0;
// src/magento/magentoClient.ts
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../utils/logger");
class MagentoClient {
    constructor() {
        const baseUrl = process.env.MAGENTO_BASE_URL;
        const token = process.env.MAGENTO_API_TOKEN;
        this.storeCode = process.env.MAGENTO_STORE_CODE || 'default';
        this.freeShippingMethod =
            process.env.MAGENTO_FREE_SHIPPING_METHOD || 'freeshipping';
        this.codMethod = process.env.MAGENTO_COD_METHOD || 'cashondelivery';
        if (!baseUrl)
            throw new Error('MAGENTO_BASE_URL is not configured');
        if (!token)
            throw new Error('MAGENTO_API_TOKEN is not configured');
        this.client = axios_1.default.create({
            // You control whether baseUrl includes /rest or not
            baseURL: `${baseUrl}/${this.storeCode}`,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });
    }
    async request(ctx, config) {
        try {
            const res = await this.client.request(config);
            return res.data;
        }
        catch (err) {
            if (err?.response) {
                (0, logger_1.logError)(ctx, `Magento ${config.method} ${config.url} error`, {
                    url: config.url,
                    status: err.response.status,
                    data: err.response.data
                });
            }
            else {
                (0, logger_1.logError)(ctx, `Magento ${config.method} ${config.url} error`, {
                    message: err?.message || String(err)
                });
            }
            throw err;
        }
    }
    //─────────────────────────────────────────
    // CART
    //─────────────────────────────────────────
    async createGuestCart() {
        const ctx = 'magento:createGuestCart';
        return this.request(ctx, {
            method: 'POST',
            url: '/V1/guest-carts'
        });
    }
    async addItemToGuestCart(cartId, item) {
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
    async setGuestCartAddresses(cartId, order) {
        const ctx = 'magento:setGuestCartAddresses';
        const streetLines = String(order.street || '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        const hasRegionId = order.region_id !== undefined &&
            order.region_id !== null &&
            String(order.region_id).trim() !== '';
        const hasRegionName = order.region !== undefined &&
            order.region !== null &&
            String(order.region).trim() !== '';
        const hasRegion = hasRegionId || hasRegionName;
        const regionMap = {
            '714': { code: 'CABA', name: 'Ciudad Autónoma de Buenos Aires' },
            '715': { code: 'BA', name: 'Buenos Aires' }
        };
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
        if (hasRegion) {
            let regionName = hasRegionName ? String(order.region).trim() : '';
            let regionId;
            let regionCode;
            if (hasRegionId) {
                const key = String(order.region_id).trim();
                const meta = regionMap[key];
                if (meta) {
                    regionName = meta.name;
                    regionCode = meta.code;
                }
                regionId = Number(order.region_id);
            }
            if (regionName)
                address.region = regionName;
            if (regionId !== undefined)
                address.region_id = regionId;
            if (regionCode)
                address.region_code = regionCode;
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
    async setPaymentMethodCOD(cartId) {
        const ctx = 'magento:setPaymentMethodCOD';
        await this.request(ctx, {
            method: 'PUT',
            url: `/V1/guest-carts/${encodeURIComponent(cartId)}/selected-payment-method`,
            data: {
                method: { method: this.codMethod }
            }
        });
    }
    async placeGuestOrder(cartId) {
        const ctx = 'magento:placeGuestOrder';
        return this.request(ctx, {
            method: 'PUT',
            url: `/V1/guest-carts/${encodeURIComponent(cartId)}/order`
        });
    }
    //─────────────────────────────────────────
    // ORDER COMMENT
    //─────────────────────────────────────────
    async addOrderComment(orderId, comment) {
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
    async createInvoice(orderId) {
        const ctx = 'magento:createInvoice';
        const invoiceId = await this.request(ctx, {
            method: 'POST',
            url: `/V1/order/${orderId}/invoice`,
            data: {
                capture: true
            }
        });
        return invoiceId;
    }
    async createShipment(orderId) {
        const ctx = 'magento:createShipment';
        const shipmentId = await this.request(ctx, {
            method: 'POST',
            url: `/V1/order/${orderId}/ship`,
            data: {
            // add items/tracking here if your Magento requires it
            }
        });
        return shipmentId;
    }
    //─────────────────────────────────────────
    // OSTOYA ORDER / CUSTOMER BACKDATING
    //─────────────────────────────────────────
    async backdateOrder(orderId, createdAt) {
        const ctx = 'magento:backdateOrder';
        await this.request(ctx, {
            method: 'POST',
            url: `/V1/ostoya/orders/${orderId}/backdate`,
            data: {
                orderId,
                createdAt
            }
        });
    }
    /**
     * Attach (or create) customer for an order and optionally backdate it.
     * If createdAt is null/undefined, Magento will keep its current created_at.
     */
    async attachCustomerAndBackdate(orderId, email, firstname, lastname, createdAt) {
        const ctx = 'magento:attachCustomerAndBackdate';
        await this.request(ctx, {
            method: 'POST',
            url: `/V1/ostoya/orders/${orderId}/attach-customer`,
            data: {
                orderId,
                email,
                firstname,
                lastname,
                createdAt: createdAt ?? null
            }
        });
    }
    async backdateInvoice(invoiceId, createdAt) {
        const ctx = 'magento:backdateInvoice';
        await this.request(ctx, {
            method: 'POST',
            url: `/V1/ostoya/invoices/${invoiceId}/backdate`,
            data: {
                invoiceId,
                createdAt
            }
        });
    }
    async backdateShipment(shipmentId, createdAt) {
        const ctx = 'magento:backdateShipment';
        await this.request(ctx, {
            method: 'POST',
            url: `/V1/ostoya/shipments/${shipmentId}/backdate`,
            data: {
                shipmentId,
                createdAt
            }
        });
    }
    async getOrderById(orderId) {
        const ctx = 'magento:getOrderById';
        return this.request(ctx, {
            method: 'GET',
            url: `/V1/orders/${orderId}`
        });
    }
}
exports.MagentoClient = MagentoClient;
// Singleton instance used by services/workers
exports.magentoClient = new MagentoClient();
exports.default = exports.magentoClient;
