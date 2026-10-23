export class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}
