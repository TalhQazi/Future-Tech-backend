export class AiUnavailableError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.name = 'AiUnavailableError';
    this.retryable = retryable;
  }
}
