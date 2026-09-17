import type { JSX } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import type { LevelSpec } from "./level-keys.ts";
import type { UiLifecycle } from "../presentation.ts";

/** Shared reading measure for Goal, Plan and Workflow detail content. */
export function DetailColumn(props: { children: JSX.Element; fill?: boolean }): JSX.Element {
  return (
    <box
      flexDirection="column"
      maxWidth={100}
      minWidth={0}
      minHeight={0}
      flexGrow={props.fill ? 1 : undefined}
    >
      {props.children}
    </box>
  );
}

/** The primary content title, separate from the screen's navigation label. */
export function DetailTitle(props: { children: JSX.Element }): JSX.Element {
  return (
    <text fg={tokens.accent2} wrapMode="word">
      <b>{props.children}</b>
    </text>
  );
}

/** Consistent section rhythm and heading color across execution detail screens. */
export function DetailHeading(props: { children: JSX.Element }): JSX.Element {
  return (
    <text marginTop={1} fg={tokens.accent}>
      {props.children}
    </text>
  );
}

/** Shared semantic lifecycle colors; labels remain owned by each domain. */
export function detailStatusColor(status: UiLifecycle | "paused" | "attention"): string {
  switch (status) {
    case "running":
    case "completed":
      return tokens.add;
    case "failed":
    case "canceled":
      return tokens.del;
    case "needs-approval":
    case "attention":
      return tokens.warn;
    case "paused":
    case "waiting":
      return tokens.muted;
  }
}

/** One close declaration for detail screens; nested pages retain a distinct back action. */
export function detailCloseActions(
  key: string,
  close: () => void,
  back?: () => void,
): Pick<LevelSpec, "verbs" | "escape"> {
  if (!back) return { escape: { label: "close", keys: ["escape", key], run: close } };
  return {
    verbs: [
      {
        key,
        label: "close",
        category: "escape",
        hintGroup: "escape",
        hintPriority: 100,
        essential: true,
        run: close,
      },
    ],
    escape: { label: "back", run: back },
  };
}
