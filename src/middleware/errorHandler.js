import mongoose from 'mongoose';
import { ZodError } from 'zod';
import multer from 'multer';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { redactText } from '../lib/redact.js';

export const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    code: 'ROUTE_NOT_FOUND',
    message: `No API route for ${req.method} ${req.originalUrl.split('?')[0]}`,
    correlationId: req.correlationId
  });
};

// Consistent error envelope: { success:false, code, message, details?, correlationId }
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, _next) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred. Reference the correlation id when reporting this.';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_FAILED';
    details = err.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
    message = details[0] ? `${details[0].path}: ${details[0].message}` : 'Invalid input';
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    code = 'VALIDATION_FAILED';
    details = Object.values(err.errors).map(e => ({ path: e.path, message: e.message }));
    message = details[0]?.message || 'Invalid data';
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'BAD_REQUEST';
    message = `Invalid value for ${err.path}`;
  } else if (err instanceof mongoose.Error.VersionError) {
    status = 409;
    code = 'VERSION_CONFLICT';
    message = 'This record was changed by someone else. Reload and try again.';
  } else if (err?.code === 11000) {
    status = 409;
    code = 'DUPLICATE';
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
    message = field ? `A record with this ${field} already exists` : 'Duplicate record';
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = 'UPLOAD_REJECTED';
    message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message;
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large';
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'MALFORMED_JSON';
    message = 'Request body is not valid JSON';
  }

  if (status >= 500) {
    console.error(JSON.stringify({
      t: new Date().toISOString(),
      level: 'error',
      cid: req.correlationId,
      path: req.originalUrl.split('?')[0],
      error: redactText(err?.message || String(err)),
      stack: env.isProd ? undefined : err?.stack
    }));
  }

  res.status(status).json({ success: false, code, message, ...(details ? { details } : {}), correlationId: req.correlationId });
};
