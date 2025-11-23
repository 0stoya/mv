// src/middleware/internalSecret.ts
import type { Request, Response, NextFunction } from 'express';

export function verifyInternalSecret(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const configuredSecret = process.env.MIDDLEWARE_SHARED_SECRET;

  // If not configured, don't block anything (you can change this to hard-fail if you want)
  if (!configuredSecret) {
    return next();
  }

  const headerSecret = req.header('x-internal-secret');

  if (!headerSecret || headerSecret !== configuredSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}
