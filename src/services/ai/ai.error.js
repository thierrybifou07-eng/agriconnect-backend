export class AiError extends Error {
  constructor(code, message, { retryAfterMs = null, cause = null } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.cause = cause;
  }
}
