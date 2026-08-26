import { formatCostUsd, sessionTurnCount, type SessionMeta } from "../adapters/session-store.ts";
import { fmtCount } from "./truncate.ts";
import { glyph } from "../theme/glyphs.ts";

/** `ms` relative to `now` as a short "Ns/m/h/d ago" string. */
export function relTime(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const TIME_COL_WIDTH = 8;

/** Column width (in characters) for the turns count, shared by every session-row renderer. */
export const TURNS_COL_WIDTH = 9;

/** Column width (in characters) for the tokens cell, shared by every session-row renderer. */
export const TOKENS_COL_WIDTH = 12;

/** Column width (in characters) for the cost cell, shared by every session-row renderer. */
export const COST_COL_WIDTH = 7;

/** The tokens column's text: `↑input ↓output`, or empty when the session has no totals yet. */
export function tokensCellText(m: SessionMeta): string {
  return m.totals && (m.totals.input > 0 || m.totals.output > 0)
    ? `${glyph("arrowUp")}${fmtCount(m.totals.input)} ${glyph("arrowDown")}${fmtCount(m.totals.output)}`
    : "";
}

/** The cost column's text, or empty when the session has no recorded cost. */
export function costCellText(m: SessionMeta): string {
  return m.totals?.costUsd != null ? formatCostUsd(m.totals.costUsd) : "";
}

/**
 * One session as a plain text line — the `--list` view of the same columns the
 * Sessions hub renders (relative time, turns, tokens, cost, title).
 */
export function formatSessionRow(m: SessionMeta, now: number): string {
  const cols = [
    m.id,
    relTime(m.updatedAt, now).padEnd(TIME_COL_WIDTH),
    `${sessionTurnCount(m)} turns`.padEnd(TURNS_COL_WIDTH),
    tokensCellText(m).padEnd(TOKENS_COL_WIDTH),
    costCellText(m).padEnd(COST_COL_WIDTH),
    m.title || "(untitled)",
  ];
  return cols.join("  ").trimEnd();
}
