import { z } from 'zod';
import { asyncHandler, parsePagination, expectedVersion } from '../../lib/http.js';

export { z, asyncHandler as h, expectedVersion };

export const id = z.string().trim().min(1).max(128);
export const cents = z.number().int().min(0).max(100_000_000_000);
export const posCents = z.number().int().min(1).max(100_000_000_000);
export const text = (max = 2000) => z.string().trim().max(max);
export const reqText = (max = 2000) => z.string().trim().min(1).max(max);
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const isoDate = z.string().datetime({ offset: true }).or(dateStr);

export const page = (req) => parsePagination(req.query);
export const ok = (res, body = {}, status = 200) => res.status(status).json({ success: true, ...body });
