export class DesktopError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DesktopError';
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details) {
  if (!condition) throw new DesktopError(code, message, details);
}

export function errorResult(error) {
  return {
    ok: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || String(error),
      ...(error.details || {}),
    },
  };
}
