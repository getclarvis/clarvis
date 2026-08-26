/**
 * Formats a millisecond duration as a compact elapsed-time string.
 *
 * @param ms - Elapsed duration in milliseconds; negative values clamp to 0.
 * @returns `"<seconds>s"` under a minute, otherwise `"<minutes>m<seconds>s"` with
 * seconds zero-padded to two digits.
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
