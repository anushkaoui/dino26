export class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
export function requireThat(condition, status, code, message, details) {
  if (!condition) throw new HttpError(status, code, message, details);
}
export function exactKeys(value, keys) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(k => keys.includes(k)), 400, 'BAD_BODY', 'Invalid request fields.');
}
