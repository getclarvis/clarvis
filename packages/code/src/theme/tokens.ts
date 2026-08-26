import { batch, createSignal, untrack } from "solid-js";
import type { ResolvedTokens } from "../core/theme-types.ts";
import { SUBAGENT_ORDER, type SubagentName, type TokenName } from "../core/theme-types.ts";

/** Re-exported from `core/theme-types` for consumers that only need the live token values. */
export { SUBAGENT_ORDER, type SubagentName, type TokenName };

/** Live, reactive theme token values (each a Solid-signal-backed getter). */
export interface Tokens {
  accent: string;
  accent2: string;
  bg: string;
  bgElev: string;
  fg: string;
  muted: string;
  add: string;
  warn: string;
  del: string;
  subagent(i: number): string;
}

const [subagentRamp, setSubagentRamp] = createSignal<readonly string[]>([
  "#a78bfa",
  "#38bdf8",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#c084fc",
]);

const [accent, setAccent] = createSignal("#a5a0f5");
const [accent2, setAccent2] = createSignal("#c4b5fd");
const [bg, setBg] = createSignal("#0f1020");
const [bgElev, setBgElev] = createSignal("#171433");
const [fg, setFg] = createSignal("#c7c9d9");
const [muted, setMuted] = createSignal("#9195ad");
const [add, setAdd] = createSignal("#3fb950");
const [warn, setWarn] = createSignal("#d29922");
const [del, setDel] = createSignal("#f85149");

/** The process-wide {@link Tokens} singleton; reads the current theme's resolved colors reactively. */
export const tokens: Tokens = {
  get accent() {
    return accent();
  },
  get accent2() {
    return accent2();
  },
  get bg() {
    return bg();
  },
  get bgElev() {
    return bgElev();
  },
  get fg() {
    return fg();
  },
  get muted() {
    return muted();
  },
  get add() {
    return add();
  },
  get warn() {
    return warn();
  },
  get del() {
    return del();
  },
  subagent(i: number): string {
    const ramp = subagentRamp();
    return ramp[((i % ramp.length) + ramp.length) % ramp.length]!;
  },
};

/**
 * Pushes a fully resolved token set into the {@link tokens} signals.
 *
 * @remarks Runs untracked and only updates signals whose value actually
 * changed, so applying an unchanged theme causes no re-renders.
 */
export function applyResolvedTokens(map: ResolvedTokens): void {
  untrack(() => {
    batch(() => {
      const set = (sig: (v: string) => void, cur: string, next: string): void => {
        if (cur !== next) sig(next);
      };
      set(setAccent, accent(), map.accent);
      set(setAccent2, accent2(), map["accent-2"]);
      set(setBg, bg(), map.bg);
      set(setBgElev, bgElev(), map["bg-elev"]);
      set(setFg, fg(), map.fg);
      set(setMuted, muted(), map.muted);
      set(setAdd, add(), map.add);
      set(setWarn, warn(), map.warn);
      set(setDel, del(), map.del);
      if (subagentRamp().join(" ") !== map.subagent.join(" ")) setSubagentRamp(map.subagent);
    });
  });
}
