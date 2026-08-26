import type { Accessor, JSX } from "solid-js";
import { detachObserved } from "../../core/tasks.ts";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tone } from "../../theme/tone.ts";
import type { Scope, ViewHost } from "../../keys/commands.ts";
import { agentReadiness } from "../../adapters/agent-files.ts";
import type { KeysAdapter } from "../../adapters/provider-secrets.ts";
import type { DoctorCtx, DoctorReport, Gate, GateId, GateResult } from "../../onboarding/doctor.ts";
import { registerLevel, verb, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { promptForApiKey } from "./key-entry.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  SelectableList,
  SelectableRow,
  ViewFrame,
} from "./view-host.tsx";
import { errorText } from "../../adapters/errors.ts";

/** Data and actions {@link DoctorView} needs from its host. */
export interface DoctorViewDeps {
  ctx: DoctorCtx;
  report: Accessor<DoctorReport>;
  recheck: () => void;
  openFix: (
    view: "providers" | "model" | "defaults" | "theme" | "agents" | "memory" | "controls",
    scope: Scope,
  ) => void;
  startAnyway: () => void;
  keys: KeysAdapter;
  notify: (message: string) => void;
  /** Opens the shared Settings > Keyboard diagnostic. */
  openKeyboard?: () => void;
  /** True when the doctor blocks boot (bootGate said "doctor"). */
  boot?: boolean;
}

function gateTone(r: GateResult): "ok" | "warn" | "error" {
  return r.status === "pass" ? "ok" : r.status === "fail" ? "error" : "warn";
}

function groupOf(g: Gate): number {
  return g.severity === "hard" ? 0 : g.severity === "soft" ? 1 : 2;
}

function gateGlyph(g: Gate, r: GateResult): string {
  if (g.severity === "comms" && r.status === "warn") return glyph("pending");
  return tone(gateTone(r)).glyph;
}

/**
 * Readiness checklist ("doctor") over required, recommended and
 * informational gates, each with a one-key fix action, plus start-anyway on
 * the boot path.
 *
 * @remarks
 * A hard-severity gate failure always blocks starting; a soft-severity gate
 * can be skipped for the session via `[-]`, which counts it as ready without
 * changing its underlying result.
 */
export function DoctorView(host: ViewHost, deps: DoctorViewDeps): JSX.Element {
  const fe = createFieldEditor(host.interaction, host.active);
  // The scope decides where a fix writes and which scope a fix view opens at, so
  // the toggle retargets rather than reloads. Declaring it is what keeps
  // `[^t] scope` in this screen's footer.
  host.bindScope({ mode: "retarget" });
  const allRows = createMemo<Gate[]>(() =>
    [...deps.report().gates].sort((a, b) => groupOf(a) - groupOf(b)),
  );
  const [sel, setSel] = createSignal(0);
  const [skipped, setSkipped] = createSignal<Set<GateId>>(new Set());
  const [showDetails, setShowDetails] = createSignal(false);

  const resultOf = (g: Gate): GateResult => deps.report().results[g.id];
  const isResolved = (g: Gate): boolean => resultOf(g).status === "pass" || skipped().has(g.id);
  const issueRows = createMemo(() =>
    allRows().filter((g) => !isResolved(g) && (g.severity === "hard" || g.severity === "soft")),
  );
  const recommendationRows = createMemo(() =>
    allRows().filter((g) => !isResolved(g) && g.severity !== "hard" && g.severity !== "soft"),
  );
  const unresolvedRows = createMemo(() => [...issueRows(), ...recommendationRows()]);
  const hasIssues = createMemo(() => issueRows().length > 0);
  const actionRows = createMemo(() =>
    unresolvedRows().filter((g) => {
      const fix = resultOf(g).fix ?? g.fix;
      return fix !== undefined || g.severity === "soft";
    }),
  );
  const passiveRows = createMemo(() =>
    unresolvedRows().filter((g) => !actionRows().some((candidate) => candidate.id === g.id)),
  );
  const clamp = (i: number): number => Math.max(0, Math.min(actionRows().length - 1, i));

  const hardFail = createMemo(() =>
    allRows().some((g) => g.severity === "hard" && resultOf(g).status === "fail"),
  );
  const liveBlocked = createMemo(() =>
    allRows().some((g) => {
      const r = resultOf(g);
      if (g.severity === "hard") return r.status === "fail";
      if (g.severity === "soft") return r.status !== "pass" && !skipped().has(g.id);
      return false;
    }),
  );

  createEffect(() => {
    deps.report();
    setSel((current) => clamp(current));
  });

  const readyCount = createMemo(() => allRows().filter((g) => isResolved(g)).length);

  function fixFocused(): void {
    const g = actionRows()[clamp(sel())];
    if (!g) return;
    const fix = resultOf(g).fix ?? g.fix;
    if (!fix) {
      deps.notify("nothing to fix here");
      return;
    }
    switch (fix.kind) {
      case "view":
        deps.openFix(fix.view, host.scope());
        break;
      case "set-default":
        doSetDefault();
        break;
      case "set-key":
        doSetKey();
        break;
      case "reconnect":
        host.dispatch("backend.reconnect");
        break;
      case "repair-settings":
        doRepairSettings(fix.scope);
        break;
    }
  }

  function doRepairSettings(scope: Scope): void {
    detachObserved("doctor_repair_settings", async () => {
      try {
        const plan = await deps.ctx.settings.planRepair(scope);
        if (!plan) {
          deps.notify("settings are valid " + glyph("emDash") + " nothing to repair");
          return;
        }
        const request =
          plan.action === "strip"
            ? {
                message: `strip invalid keys from ${scope} settings.json?`,
                detail: [plan.path, `drops: ${plan.dropped.join(", ")}`],
                danger: true,
              }
            : {
                message: `reset ${scope} settings.json to {}? its contents cannot be parsed`,
                detail: [plan.path, plan.reason],
                danger: true,
              };
        const ok = await host.confirm(request);
        if (!ok) return;
        await deps.ctx.settings.applyRepair(plan);
        deps.notify(
          plan.action === "strip"
            ? `settings repaired ${glyph("emDash")} dropped ${plan.dropped.join(", ")}`
            : `settings reset ${glyph("emDash")} ${plan.path} is now {}`,
        );
      } catch (e: unknown) {
        deps.notify(`repair failed: ${errorText(e)}`);
      } finally {
        deps.recheck();
      }
    });
  }

  function doSetKey(): void {
    const providers = deps.ctx.settings.effective().providers ?? [];
    const missing = [
      ...new Set(
        providers
          .map((p) => p.api_key_env)
          .filter((v): v is string => !!v && deps.ctx.settings.envStatus(v) === "unset"),
      ),
    ];
    if (missing.length === 0) {
      deps.notify("no missing credentials");
      return;
    }
    const enter = (envVar: string): void =>
      promptForApiKey(fe, envVar, {
        notify: deps.notify,
        commit: (value) => {
          detachObserved("doctor_set_key", async () => {
            try {
              await deps.keys.set(envVar, value);
            } catch (e) {
              deps.notify(`key save failed: ${errorText(e)}`);
              return;
            }
            deps.notify(`key saved ${glyph("emDash")} stored in keys.json for ${envVar}`);
            deps.recheck();
            host.dispatch("backend.reconnect");
          });
        },
      });
    if (missing.length === 1) {
      enter(missing[0]!);
      return;
    }
    fe.startPick(
      "which credential",
      missing.map((v) => ({ label: v, value: v })),
      enter,
    );
  }

  function doSetDefault(): void {
    const list = deps.ctx.agents.list();
    const settings = deps.ctx.settings.effective();
    const runnable = list.find(
      (a) =>
        agentReadiness(a, list, settings, deps.ctx.env, deps.ctx.settings.knownGrants()).runnable,
    );
    const name = runnable?.name ?? list[0]?.name;
    if (!name) {
      deps.notify("no agent to set");
      return;
    }
    try {
      deps.ctx.code.writeAgentDefault(host.scope(), name);
    } catch (e) {
      deps.notify(`set default failed: ${errorText(e)}`);
      return;
    }
    deps.recheck();
    deps.notify(`default agent: ${name} (${host.scope()})`);
  }

  function skipFocused(): void {
    const g = actionRows()[clamp(sel())];
    if (!g) return;
    if (g.severity !== "soft") {
      deps.notify("only recommended checks can be skipped");
      return;
    }
    if (resultOf(g).status === "pass") return;
    setSkipped((s) => new Set(s).add(g.id));
    deps.notify(`skipped: ${g.label} (this session only)`);
  }

  function startAnyway(): void {
    if (hardFail()) {
      deps.notify("required: resolve config and agents first");
      return;
    }
    deps.startAnyway();
  }

  const spec = (): LevelSpec => ({
    ...(actionRows().length > 0
      ? {
          nav: {
            count: () => actionRows().length,
            index: sel,
            setIndex: setSel,
            activate: { label: "resolve", run: fixFocused },
          },
        }
      : {}),
    verbs: [
      {
        id: "doctor.start",
        key: "g",
        category: "primary",
        hintGroup: "primary",
        hintPriority: 90,
        essential: true,
        run: deps.boot ? startAnyway : () => host.close(),
        label: deps.boot ? "start" : "back",
      },
      {
        key: "-",
        label: "skip",
        hintPriority: 80,
        run: skipFocused,
        when: () => actionRows()[clamp(sel())]?.severity === "soft",
      },
      {
        key: "d",
        label: showDetails() ? "hide details" : "show details",
        /* The only way to see what the summary counted. On a healthy screen the
           summary is the entire content, so without a footer slot it was a
           number with no way to check it; when checks are failing they are
           already listed, and refreshing them matters more. */
        hintPriority: hasIssues() ? 60 : 85,
        run: () => setShowDetails((value) => !value),
      },
      { ...verb("refresh", () => deps.recheck()), hintPriority: 70 },
      { key: "c", label: "reconnect backend", run: () => host.dispatch("backend.reconnect") },
      { key: "u", label: "refresh model catalog", run: () => host.dispatch("catalog.refresh") },
      ...(deps.openKeyboard
        ? [
            {
              id: "keyboard.diagnostic.open",
              key: "k",
              label: "keyboard diagnostic",
              run: deps.openKeyboard,
            },
          ]
        : []),
    ],
    escape: { label: "back", run: () => host.close() },
  });

  bindLevelKeys({
    editor: fe,
    host,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  return (
    <ViewFrame
      host={host}
      title="Clarvis Doctor"
      purpose="Required checks are separate from optional recommendations"
      mutationContract={
        actionRows().length > 0 ? "Select a row and press Enter to resolve it" : undefined
      }
    >
      <box flexDirection="column" flexShrink={1} minHeight={0}>
        <Show
          when={hasIssues()}
          fallback={
            <text flexShrink={0} fg={tokens.add}>
              {`${glyph("success")} ${readyCount()} configuration checks passed`}
            </text>
          }
        >
          <text flexShrink={0} fg={hardFail() ? tokens.del : tokens.warn}>
            {`${glyph("warning")} Needs attention ${glyph("separator")} ${issueRows().length} ${issueRows().length === 1 ? "check" : "checks"}`}
          </text>
        </Show>
        <Show when={recommendationRows().length > 0}>
          <text flexShrink={0} fg={tokens.muted}>
            {`${glyph("bullet")} Recommendations ${glyph("separator")} ${recommendationRows().length} optional`}
          </text>
        </Show>
        <Show when={unresolvedRows().length > 0}>
          <box flexDirection="column" flexShrink={1} minHeight={0} paddingTop={1}>
            <For each={passiveRows()}>
              {(g) => (
                <text flexShrink={0} fg={tone(gateTone(resultOf(g))).fg}>
                  {`${gateGlyph(g, resultOf(g))} ${g.label}: ${resultOf(g).detail}`}
                </text>
              )}
            </For>
            <SelectableList<Gate>
              each={actionRows}
              sel={sel}
              idPrefix="gate-"
              contentRows={() => {
                const focused = actionRows()[clamp(sel())];
                return actionRows().length + (focused && resultOf(focused).hint ? 1 : 0);
              }}
              row={(g, i) => {
                const r = (): GateResult => resultOf(g);
                const isSkipped = (): boolean => skipped().has(g.id);
                return (
                  <>
                    <SelectableRow selected={i() === sel()}>
                      <span style={{ fg: tone(gateTone(r())).fg }}>{gateGlyph(g, r()) + " "}</span>
                      <span style={{ fg: tokens.muted }}>{g.label.padEnd(15)}</span>
                      <span style={{ fg: tokens.fg }}>{r().detail}</span>
                      <Show when={isSkipped()}>
                        <span style={{ fg: tokens.muted }}>{"  (skipped)"}</span>
                      </Show>
                    </SelectableRow>
                    <Show when={i() === sel() && r().hint}>
                      <text fg={tokens.muted} paddingLeft={4} wrapMode="word">
                        {glyph("arrowRight") + " " + r().hint}
                      </text>
                    </Show>
                  </>
                );
              }}
            />
          </box>
        </Show>
        <Show when={showDetails()}>
          <box flexDirection="column" flexShrink={1} minHeight={0} paddingTop={1}>
            <text flexShrink={0} fg={tokens.muted}>
              {"Healthy checks"}
            </text>
            <For each={allRows().filter(isResolved)}>
              {(g) => (
                <text flexShrink={0} fg={tokens.muted}>
                  {`${glyph("success")} ${g.label}: ${resultOf(g).detail}`}
                </text>
              )}
            </For>
          </box>
        </Show>
        <Show when={liveBlocked() && !hardFail()}>
          <text flexShrink={0} fg={tokens.warn} paddingTop={1}>
            {glyph("warning") +
              " recommended items pending " +
              glyph("emDash") +
              " skip the focused item or start anyway"}
          </text>
        </Show>
        <Show when={fe.editing()}>{fe.EditInput()}</Show>
        {fe.PickerInput()}
      </box>
    </ViewFrame>
  );
}
