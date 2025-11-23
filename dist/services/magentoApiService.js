"use strict";
// src/services/magentoApiService.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.magentoApiService = void 0;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../utils/logger");
require("dotenv/config");
const MAGENTO_BASE_URL = process.env.MAGENTO_BASE_URL;
const MAGENTO_ACCESS_TOKEN = process.env.MAGENTO_API_TOKEN;
if (!MAGENTO_BASE_URL || !MAGENTO_ACCESS_TOKEN) {
    throw new Error("Missing MAGENTO_BASE_URL or MAGENTO_API_TOKEN environment variables.");
}
const axiosInstance = axios_1.default.create({
    baseURL: MAGENTO_BASE_URL,
    headers: {
        'Authorization': `Bearer ${MAGENTO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
    },
    timeout: 30000,
});
exports.magentoApiService = {
    /**
     * Creates a new order in Magento via POST /V1/orders.
     * @param orderData The fully constructed order payload for Magento.
     * @returns The Magento Order Increment ID (string) and Entity ID (number, derived).
     */
    async createOrder(orderData) {
        const ctx = `magentoApi:createOrder`;
        const url = `/V1/orders`;
        try {
            const response = await axiosInstance.post(url, { entity: orderData });
            const magentoIncrementId = response.data?.increment_id || response.data?.toString();
            // CRITICAL NOTE: Replace 99999 with logic to find the internal Magento Entity ID
            // by querying the order using magentoIncrementId.
            const magentoOrderId = 99999;
            if (!magentoIncrementId) {
                throw new Error('Magento did not return a valid increment ID.');
            }
            (0, logger_1.logInfo)(ctx, 'Order created successfully.', { magentoIncrementId });
            return { magentoOrderId: magentoOrderId, magentoIncrementId: magentoIncrementId };
        }
        catch (error) {
            (0, logger_1.logError)(ctx, 'Failed to create order in Magento.', {
                status: error.response?.status,
                data: error.response?.data
            });
            throw error;
        }
    },
    /**
     * Creates an invoice for a specific Magento Order ID (entity ID).
     */
    async createInvoice(magentoOrderId) {
        const ctx = `magentoApi:invoice:${magentoOrderId}`;
        // **FIXED ROUTE**: Uses singular 'order'
        const url = `/V1/order/${magentoOrderId}/invoice`;
        const payload = { capture: true, items: [] };
        try {
            const response = await axiosInstance.post(url, payload);
            return response.data;
        }
        catch (error) {
            (0, logger_1.logError)(ctx, 'Failed to create invoice in Magento.', { status: error.response?.status });
            throw error;
        }
    },
    /**
     * Creates a shipment for a specific Magento Order ID (entity ID).
     */
    async createShipment(magentoOrderId) {
        const ctx = `magentoApi:shipment:${magentoOrderId}`;
        // ROUTE CHECKED: Uses singular 'order'
        const url = `/V1/order/${magentoOrderId}/ship`;
        const payload = { items: [] };
        try {
            const response = await axiosInstance.post(url, payload);
            return response.data;
        }
        catch (error) {
            (0, logger_1.logError)(ctx, 'Failed to create shipment in Magento.', { status: error.response?.status });
            throw error;
        }
    }
};
