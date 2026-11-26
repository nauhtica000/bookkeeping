// Calls into the main process. Every failure becomes an ApiError carrying the
// user-facing message and any per-field messages.

export class ApiError extends Error {
  constructor({ name, message, fields }) {
    super(message);
    this.name = name || 'Error';
    this.fields = fields || {};
  }
}

export async function call(method, args = {}) {
  if (!window.mma) throw new ApiError({ message: 'MMA Books must be run as the desktop app.' });
  const res = await window.mma.call(method, args);
  if (!res || !res.ok) throw new ApiError(res?.error || { message: 'Something went wrong.' });
  return res.data;
}

// Shared lookup data (payment methods, categories, customers...) cached
// between screens and refreshed after edits.
let lookupsCache = null;
export async function lookups({ refresh = false } = {}) {
  if (!lookupsCache || refresh) lookupsCache = await call('lookups.all');
  return lookupsCache;
}
export function invalidateLookups() {
  lookupsCache = null;
}
