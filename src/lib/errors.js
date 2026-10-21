// Typed application errors. Every error response carries a stable `code`,
// a human readable `message` and the request correlation id.

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

export const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
export const validationError = (message, details) => new AppError(400, 'VALIDATION_FAILED', message, details);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to perform this action', code = 'FORBIDDEN') => new AppError(403, code, message);
export const notFound = (entity = 'Resource') => new AppError(404, 'NOT_FOUND', `${entity} not found`);
export const conflict = (message, code = 'CONFLICT', details) => new AppError(409, code, message, details);
export const versionConflict = (entity = 'Record') =>
  new AppError(409, 'VERSION_CONFLICT', `${entity} was changed by someone else. Reload and try again.`);
export const preconditionRequired = (message) => new AppError(428, 'PRECONDITION_REQUIRED', message);
export const unprocessable = (message, details, code = 'BUSINESS_RULE_VIOLATION') => new AppError(422, code, message, details);
export const tooManyRequests = (message = 'Too many requests. Please slow down.') => new AppError(429, 'RATE_LIMITED', message);
export const serviceUnavailable = (message, code = 'SERVICE_UNAVAILABLE') => new AppError(503, code, message);
