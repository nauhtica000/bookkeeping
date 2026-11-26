// Error types that carry a clear, user-facing message across IPC.

export class ValidationError extends Error {
  // fields: { fieldName: 'message' }
  constructor(message, fields = {}) {
    super(message);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

// Collects field errors, then throws one ValidationError listing them all.
export class FieldErrors {
  constructor() {
    this.fields = {};
  }
  add(field, message) {
    if (!this.fields[field]) this.fields[field] = message;
  }
  // Run fn; if it throws, record the message against `field` and return fallback.
  capture(field, fn, fallback = null) {
    try {
      return fn();
    } catch (e) {
      this.add(field, e.message);
      return fallback;
    }
  }
  get any() {
    return Object.keys(this.fields).length > 0;
  }
  throwIfAny(summary = 'Please fix the highlighted fields.') {
    if (this.any) {
      const list = Object.values(this.fields);
      throw new ValidationError(list.length === 1 ? list[0] : summary, this.fields);
    }
  }
}

export function serializeError(e) {
  // Safety net: a database constraint that slipped past validation still
  // reaches the user as a readable message rather than failing silently.
  if (e?.code && String(e.code).startsWith('SQLITE_CONSTRAINT')) {
    return {
      name: 'ConflictError',
      message: `That change conflicts with existing records and was not saved. (${e.message})`,
    };
  }
  return {
    name: e?.name || 'Error',
    message: e?.message || String(e),
    fields: e?.fields || undefined,
  };
}
