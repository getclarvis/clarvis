import { createSignal, type Accessor } from "solid-js";
import { glyph } from "../core/marks.ts";
import type { BackendProbe } from "../onboarding/doctor.ts";

/**
 * The kernel connection as structured state — the single source of truth the
 * header label AND the doctor's backend probe derive from. Nothing may parse
 * the display string: it is a projection, not a channel.
 */
export type ConnectionState =
  | { phase: "connecting"; detail?: string }
  | { phase: "ready"; detail?: string }
  | { phase: "failed"; detail?: string };

/** Reactive holder of the current {@link ConnectionState}. */
export interface ConnectionStore {
  state: Accessor<ConnectionState>;
  set(state: ConnectionState): void;
}

/** Builds a {@link ConnectionStore}, starting in the `connecting` phase. */
export function createConnectionState(): ConnectionStore {
  const [state, setState] = createSignal<ConnectionState>({ phase: "connecting" });
  return { state, set: setState };
}

/** The user-facing status label (header chip). Display only — never parsed.
 * `compact` drops any custom `detail` and shortens the failed-phase wording,
 * for use once the header's full form no longer fits. */
export function connectionLabel(s: ConnectionState, compact = false): string {
  switch (s.phase) {
    case "connecting":
      return (compact ? "connecting" : (s.detail ?? "connecting")) + glyph("ellipsis");
    case "ready":
      return s.detail ? `connected (${s.detail})` : "connected";
    case "failed":
      return compact ? "failed" : "backend connect failed";
  }
}

/** The doctor's view of the connection. */
export function connectionProbe(s: ConnectionState, profileCount: number): BackendProbe {
  if (s.phase === "ready") return { status: "reachable", profileCount };
  if (s.phase === "failed") return { status: "unreachable" };
  return { status: "checking" };
}
