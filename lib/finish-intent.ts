// Small operation metadata only; no answer text, photos, or credentials.
export type FinishIntent = {
  requestId: string;
  position: number;
  durationMs: number;
  timeout?: boolean;
};
const memory = new Map<string, FinishIntent>();
export function readFinish(id: string): FinishIntent | null {
  if (memory.has(id)) return memory.get(id)!;
  try {
    return JSON.parse(sessionStorage.getItem('finish:' + id) || 'null');
  } catch {
    return null;
  }
}
export function saveFinish(id: string, intent: FinishIntent | null) {
  if (intent) memory.set(id, intent);
  else memory.delete(id);
  try {
    if (intent) sessionStorage.setItem('finish:' + id, JSON.stringify(intent));
    else sessionStorage.removeItem('finish:' + id);
  } catch {
    /* Network completion remains available with disabled storage. */
  }
}
