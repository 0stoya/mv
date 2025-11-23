// src/utils/logger.ts
import { randomUUID } from 'crypto';

export function createContextId(scope: string): string {
  return `${scope}:${randomUUID()}`;
}

export function createChildContextId(parentCtx: string, scope: string): string {
  return `${scope}:${parentCtx.split(':')[1] ?? randomUUID()}`;
}

export function logInfo(
  ctx: string,
  msg: string,
  meta: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      ctx,
      msg,
      meta
    })
  );
}

export function logError(ctx: string, msg: string, meta: any = {}): void {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      ctx,
      msg,
      meta
    })
  );
}

/**
 * Dedicated Magento API error logger.
 * Extracts URL, status code and response message/body.
 */
export function logMagentoError(ctx: string, err: any): void {
  const axiosRes = err?.response;

  console.error(
    JSON.stringify({
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
    })
  );
}
