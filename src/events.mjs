const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
export function emit(event, payload = {}) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (error) { console.error(`[event:${event}] ${error?.stack || error}`); }
  }
}
