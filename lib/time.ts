/** Round once, then split units so 59.95 seconds carries into the next minute. */
export function duration(ms: number) {
  const tenths = Math.round(Math.max(0, Number.isFinite(ms) ? ms : 0) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  const text = seconds.toFixed(1).replace('.', ',');
  return minutes ? `${minutes} мин ${seconds < 10 ? '0' : ''}${text} с` : `${text} с`;
}
export type ClockAnchor = { elapsed: number; wall: number; mono: number };
export function elapsed(anchor: ClockAnchor, wall = Date.now(), mono = performance.now()) {
  // Some mobile browsers suspend their monotonic clock while the screen is locked.
  return Math.round(anchor.elapsed + Math.max(0, mono - anchor.mono, wall - anchor.wall));
}
