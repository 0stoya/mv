"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContextId = createContextId;
exports.createChildContextId = createChildContextId;
exports.logInfo = logInfo;
exports.logError = logError;
exports.logMagentoError = logMagentoError;
// src/utils/logger.ts
const crypto_1 = require("crypto");
function createContextId(scope) {
    return `${scope}:${(0, crypto_1.randomUUID)()}`;
}
function createChildContextId(parentCtx, scope) {
    return `${scope}:${parentCtx.split(':')[1] ?? (0, crypto_1.randomUUID)()}`;
}
function logInfo(ctx, msg, meta = {}) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        ctx,
        msg,
        meta
    }));
}
function logError(ctx, msg, meta = {}) {
    console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        ctx,
        msg,
        meta
    }));
}
/**
 * Dedicated Magento API error logger.
 * Extracts URL, status code and response message/body.
 */
function logMagentoError(ctx, err) {
    const axiosRes = err?.response;
    console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        ctx,
        msg: 'Magento API Error',
        meta: {
            url: axiosRes?.config?.url,
            method: axiosRes?.config?.method,
            status: axiosRes?.status,
            data: axiosRes?.data,
            message: err?.message || 'Unknown Magento error'
        }
    }));
}
