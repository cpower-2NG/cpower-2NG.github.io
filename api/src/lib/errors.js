export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function assert(condition, status, message, code) {
  if (!condition) {
    throw new HttpError(status, message, code);
  }
}
