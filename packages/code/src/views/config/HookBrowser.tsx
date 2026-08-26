import type { Accessor, JSX } from "solid-js";
import type { PluginHookReview } from "@clarvis/protocol";
import { createSignal, For, Show } from "solid-js";

import type { ViewHost } from "../../keys/commands.ts";
import { tokens } from "../../theme/tokens.ts";
import { padColumn } from "../truncate.ts";
import { tone } from "../../theme/tone.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import {
  bindLevelKeys,
  DetailLines,
  SelectableList,
  SelectableRow,
  ViewFrame,
} from "./view-host.tsx";

/** One operator-authored `settings.json` hook, with the scope that declares it. */
export interface OperatorHook {
  scope: "global" | "workspace";
  definition: unknown;
  /**
   * Whether the workspace-trust gate is withholding this hook from the merged
   * settings the kernel actually runs.
   *
   * @remarks `hooks` is a `WORKSPACE_RISK_FIELDS` entry, so an unapproved
   *   repository's hooks are parsed and shown but never fired. Listing them
   *   unmarked told the operator these were theirs and running, on exactly the
   *   screen they would consult to find out.
   */
  withheld?: boolean;
}

export interface HookBrowserDeps {
  hooks: Accessor<PluginHookReview[]>;
  /**
   * The operator's own `settings.json` hooks.
   *
   * @remarks Listed because this is the screen the Extensions hub advertises as
   *   "Configure workspace automations", and it used to show plugin-contributed
   *   hooks only — so an operator's own hooks, which are the ones most likely to
   *   be running, appeared nowhere in the application at all. They are read-only
   *   here: they need no approval (an operator hook always judges first) and the
   *   file is the place to edit them.
   */
  operatorHooks: Accessor<OperatorHook[]>;
  approve(review: PluginHookReview): void;
  revoke(review: PluginHookReview): void;
}

function definition(review: PluginHookReview): string {
  return JSON.stringify(review.definition);
}

/** Review exact normalized plugin-hook definitions independently of plugin enablement. */
export function HookBrowser(host: ViewHost, deps: HookBrowserDeps): JSX.Element {
  const [sel, setSel] = createSignal(0);
  const selected = (): PluginHookReview | undefined =>
    deps.hooks()[clampListIndex(sel(), deps.hooks().length)];
  const spec = (): LevelSpec => ({
    nav: { count: () => deps.hooks().length, index: sel, setIndex: setSel },
    verbs: [
      {
        key: "t",
        label: "approve exact hook",
        when: () => selected()?.approved === false,
        run: () => {
          const review = selected();
          if (review) deps.approve(review);
        },
      },
      {
        key: "x",
        label: "revoke",
        when: () => selected()?.approved === true,
        run: () => {
          const review = selected();
          if (review) deps.revoke(review);
        },
      },
    ],
  });
  bindLevelKeys({
    host,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });
  return (
    <ViewFrame host={host} title="Hooks" unscoped>
      <text fg={tokens.accent2} flexShrink={0}>
        {`Plugin hooks (${deps.hooks().length})`}
      </text>
      <SelectableList<PluginHookReview>
        each={deps.hooks}
        sel={sel}
        idPrefix="hook-"
        empty={() => ({ text: "no plugin hooks declared" })}
        row={(review, index) => (
          <SelectableRow selected={sel() === index()}>
            <span style={{ fg: tone(review.approved ? "ok" : "warn").fg }}>
              {tone(review.approved ? "ok" : "warn").glyph}{" "}
            </span>
            <span style={{ fg: tokens.fg }}>{review.plugin}</span>
            <span style={{ fg: tokens.muted }}>
              {`  ${review.approved ? "approved" : "review required"}`}
            </span>
          </SelectableRow>
        )}
        trailing={
          selected() ? (
            <DetailLines
              rows={[
                { text: selected()!.fingerprint, fg: tokens.muted },
                { text: definition(selected()!), fg: tokens.warn },
              ]}
            />
          ) : undefined
        }
      />
      <text fg={tokens.accent2} flexShrink={0} paddingTop={1}>
        {`Your hooks, from settings.json (${deps.operatorHooks().length})`}
      </text>
      <Show
        when={deps.operatorHooks().length > 0}
        fallback={
          <text fg={tokens.muted} flexShrink={0}>
            none declared
          </text>
        }
      >
        <For each={deps.operatorHooks()}>
          {(hook) => (
            <text flexShrink={0} wrapMode="none" truncate>
              <span style={{ fg: tokens.fg }}>{padColumn(hook.scope, 11)}</span>
              <span style={{ fg: tokens.muted }}>{JSON.stringify(hook.definition)}</span>
              <Show when={hook.withheld}>
                <span style={{ fg: tokens.warn }}>{"  not running: workspace not approved"}</span>
              </Show>
            </text>
          )}
        </For>
      </Show>
    </ViewFrame>
  );
}
