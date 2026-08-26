import type { JSX } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { SandboxInspection } from "@clarvis/protocol";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import { tone } from "../../theme/tone.ts";
import type { ViewHost } from "../../keys/commands.ts";
import type { SettingsAdapter, SettingsFile } from "../../adapters/settings.ts";
import { registerLevel, verb, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  DetailLines,
  ErrorBanner,
  LoadingHint,
  SettingRow,
  StatusRow,
  ViewFrame,
} from "./view-host.tsx";

/** Data and actions {@link SandboxConfigPanel} needs from its host. */
export interface SandboxConfigDeps {
  settings: SettingsAdapter;
  notify: (message: string) => void;
}

type SandboxDraft = NonNullable<SettingsFile["sandbox"]>;

const ROW_COUNT = 9;

function parseList(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function showList(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(" ") : "(none)";
}

function showConfiguredList(values: string[] | undefined): string {
  return values === undefined ? "inherit" : showList(values);
}

/**
 * Config panel for the per-scope Bubblewrap sandbox block: enable/disable,
 * availability, filesystem/network posture and toolchain discovery, plus a
 * live host inspection (Bubblewrap availability, discovered toolchains).
 *
 * @remarks
 * The discovered toolchain/path list is rendered in a scrollbox sized to its
 * content (`flexShrink` + `minHeight={0}`) so it hugs when everything fits
 * and scrolls instead of overflowing the pinned footer when the terminal is
 * short, letting the flex chain squeeze it before the fixed field rows above.
 */
/**
 * The shape a POSIX environment variable name may take.
 *
 * @remarks The sandbox's allow-list is passed to a child process by name, so an
 * entry that is not a legal name can never match anything. It used to be
 * accepted and persisted unchecked while the panel's Default-model and
 * Total-token-limit fields next to it validated strictly.
 */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function SandboxConfigPanel(host: ViewHost, deps: SandboxConfigDeps): JSX.Element {
  const fe = createFieldEditor(host.interaction, host.active);
  const [draft, setDraft] = createSignal<SandboxDraft | null>(null);
  const [sel, setSel] = createSignal(0);
  const [savedVersion, setSavedVersion] = createSignal(0);
  const [inspection, setInspection] = createSignal<SandboxInspection | null>(null);
  const [inspectionError, setInspectionError] = createSignal<string | null>(null);
  const [inspecting, setInspecting] = createSignal(false);
  let inspectionRequest = 0;
  let disposed = false;
  const [showUnavailable, setShowUnavailable] = createSignal(false);
  const availability = () => inspection()?.bubblewrap;
  const visibleToolchains = () =>
    (inspection()?.toolchains ?? [])
      .filter((toolchain) => showUnavailable() || toolchain.available)
      .sort((a, b) => Number(b.available) - Number(a.available));
  const unavailableCount = () =>
    (inspection()?.toolchains ?? []).filter((toolchain) => !toolchain.available).length;
  const toolchainRows = (): number =>
    visibleToolchains().length + (inspection()?.extra_paths.length ?? 0) + 2;

  async function refreshInspection(refresh = false): Promise<void> {
    const request = ++inspectionRequest;
    setInspecting(true);
    setInspectionError(null);
    try {
      const next = await deps.settings.inspectSandbox({ refresh });
      if (!disposed && request === inspectionRequest) setInspection(next);
    } catch (error) {
      if (!disposed && request === inspectionRequest) setInspectionError(String(error));
    } finally {
      if (!disposed && request === inspectionRequest) setInspecting(false);
    }
  }

  onMount(() => void refreshInspection());
  onCleanup(() => {
    disposed = true;
    inspectionRequest++;
  });

  /**
   * The block as last loaded from disk, for deciding whether a draft differs.
   *
   * @remarks `markDirty` is a latch, so enabling the block and removing it again
   * — a round trip back to exactly what is stored — left "Unsaved" on screen
   * and armed the discard confirmation over a change that no longer existed.
   */
  let savedSnapshot = "null";

  function load(): void {
    const value = deps.settings.read(host.scope())?.sandbox;
    setDraft(value ? { ...value } : null);
    setSel(0);
    savedSnapshot = JSON.stringify(value ?? null);
    host.markDirty(false);
  }

  /** Marks dirty only when the draft actually differs from what was loaded. */
  function refreshDirty(): void {
    host.markDirty(JSON.stringify(draft()) !== savedSnapshot);
  }
  host.bindScope({ mode: "reload", load });
  load();

  function patch(value: Partial<SandboxDraft>): void {
    const current = draft();
    if (!current) return;
    setDraft({ ...current, ...value });
    refreshDirty();
  }

  function createBlock(): void {
    const inherited = deps.settings.effective().sandbox;
    setDraft({
      type: "bubblewrap",
      enabled: inherited?.enabled ?? true,
      availability: inherited?.availability ?? "required",
      filesystem: inherited?.filesystem ?? "workspace-write",
      network: inherited?.network ?? "host",
      pass_env: inherited?.pass_env,
      toolchains: inherited?.toolchains ? { ...inherited.toolchains } : { mode: "auto" },
    });
    refreshDirty();
    const avail = availability();
    if (avail && !avail.available) {
      deps.notify(
        `heads up: Bubblewrap is ${avail.reason ?? "unavailable"} here ${glyph("emDash")} ` +
          `a 'required' sandbox will fail runs on this host`,
      );
    }
  }

  function removeBlock(): void {
    if (!draft()) return;
    setDraft(null);
    setSel(0);
    refreshDirty();
    deps.notify(
      `sandbox block removed from the ${host.scope()} draft ${glyph("emDash")} ` +
        `inherits other scopes after the draft is saved`,
    );
  }

  async function save(): Promise<void> {
    await deps.settings.write(host.scope(), { sandbox: draft() ?? undefined });
    host.markDirty(false);
    setSavedVersion((v) => v + 1);
    deps.notify(
      draft()
        ? `saved ${host.scope()} sandbox config`
        : `sandbox block removed from ${host.scope()} settings`,
    );
  }
  host.onSave(save);

  const rowCount = (): number => (draft() ? ROW_COUNT : 1);

  function editSelected(): void {
    const current = draft();
    if (!current) {
      createBlock();
      return;
    }
    if (sel() === 0) {
      patch({ enabled: current.enabled === false });
    } else if (sel() === 1) {
      fe.startEnum(
        "availability",
        ["required", "optional"],
        current.availability ?? "required",
        (v) => patch({ availability: v as SandboxDraft["availability"] }),
      );
    } else if (sel() === 2) {
      fe.startEnum(
        "filesystem",
        ["workspace-write", "workspace-read-only"],
        current.filesystem ?? "workspace-write",
        (v) => patch({ filesystem: v as SandboxDraft["filesystem"] }),
      );
    } else if (sel() === 3) {
      fe.startEnum("network", ["host", "none"], current.network ?? "host", (v) =>
        patch({ network: v as SandboxDraft["network"] }),
      );
    } else if (sel() === 4) {
      fe.start("pass_env (space-separated)", (current.pass_env ?? []).join(" "), (v) => {
        const list = parseList(v);
        const invalid = list.filter((name) => !ENV_VAR_NAME.test(name));
        if (invalid.length > 0) {
          deps.notify(`not valid environment variable names: ${invalid.slice(0, 3).join(", ")}`);
          return;
        }
        patch({ pass_env: list.length > 0 ? list : undefined });
      });
    } else if (sel() === 5) {
      fe.startEnum("toolchain mode", ["auto", "manual"], current.toolchains?.mode ?? "auto", (v) =>
        patch({
          toolchains: {
            ...current.toolchains,
            mode: v as NonNullable<SandboxDraft["toolchains"]>["mode"],
          },
        }),
      );
    } else if (sel() === 6) {
      fe.start(
        "toolchains include (space-separated; blank = defaults)",
        (current.toolchains?.include ?? []).join(" "),
        (v) => {
          const list = parseList(v);
          patch({
            toolchains: {
              ...current.toolchains,
              include: list.length > 0 ? list : undefined,
            },
          });
        },
      );
    } else if (sel() === 7) {
      fe.start(
        "toolchains exclude (space-separated)",
        (current.toolchains?.exclude ?? []).join(" "),
        (v) => {
          const list = parseList(v);
          patch({
            toolchains: {
              ...current.toolchains,
              exclude: list.length > 0 ? list : undefined,
            },
          });
        },
      );
    } else {
      fe.start(
        "extra toolchain paths (space-separated)",
        (current.toolchains?.extra_paths ?? []).join(" "),
        (v) => {
          const list = parseList(v);
          const bad = host.scope() === "global" ? list.find((p) => !p.startsWith("/")) : undefined;
          if (bad !== undefined) {
            deps.notify(`global toolchain paths must be absolute ${glyph("emDash")} got "${bad}"`);
            return;
          }
          patch({
            toolchains: {
              ...current.toolchains,
              extra_paths: list.length > 0 ? list : undefined,
            },
          });
        },
      );
    }
  }

  const spec = (): LevelSpec => ({
    nav: {
      count: rowCount,
      index: sel,
      setIndex: setSel,
      activate: {
        label: draft()
          ? "toggle / edit"
          : effectiveSandbox()?.enabled === false || !effectiveSandbox()
            ? "enable"
            : `configure ${host.scope()} override`,
        run: editSelected,
      },
    },
    verbs: [
      verb("refresh", () => void refreshInspection(true)),
      {
        key: "u",
        label: showUnavailable() ? "hide unavailable" : "show unavailable",
        when: () => unavailableCount() > 0,
        run: () => setShowUnavailable((shown) => !shown),
      },
      ...(draft() ? [{ key: "x", label: "remove block", run: removeBlock }] : []),
    ],
  });

  bindLevelKeys({
    host,
    editor: fe,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  function effectiveStatus(): { text: string; fg: string } {
    void savedVersion();
    const sandbox = deps.settings.effective().sandbox;
    if (!sandbox || sandbox.enabled === false)
      return {
        text: "off " + glyph("emDash") + " commands run directly on the host",
        fg: tokens.warn,
      };
    const fallback =
      (sandbox.availability ?? "required") === "optional" ? " (falls back to direct)" : "";
    return {
      text: `on ${glyph("emDash")} ${sandbox.filesystem ?? "workspace-write"}, network:${sandbox.network ?? "host"}${fallback}`,
      fg: tokens.add,
    };
  }

  function hostWarning(): { text: string; fg: string } | null {
    void savedVersion();
    const sandbox = deps.settings.effective().sandbox;
    const enabled = sandbox && sandbox.enabled !== false;
    if (!enabled) return null;
    const required = (sandbox.availability ?? "required") === "required";
    const avail = availability();
    if (!avail) return null;
    if (!avail.available) {
      return {
        text:
          `${glyph("warning")} unavailable here (${avail.reason}) ${glyph("emDash")} ` +
          (required
            ? "runs will fail; set availability to optional or disable"
            : "commands run directly"),
        fg: tone(required ? "error" : "warn").fg,
      };
    }
    if (avail.degraded) {
      return {
        text: `${glyph("warning")} degraded mode: the sandbox shares the host /proc`,
        fg: tokens.warn,
      };
    }
    return null;
  }

  function hostColor(): string {
    const avail = availability();
    if (!avail) return inspectionError() ? tokens.del : tokens.muted;
    return avail.available ? (avail.degraded ? tokens.warn : tokens.muted) : tokens.del;
  }

  const hostText = (): string =>
    availability()?.available
      ? availability()!.degraded
        ? "Bubblewrap available (degraded: shares host /proc)"
        : "Bubblewrap available on kernel host"
      : `Bubblewrap ${availability()?.reason ?? inspectionError() ?? "unavailable"}`;

  const sandboxAt = (scope: "global" | "workspace"): SandboxDraft | undefined =>
    deps.settings.read(scope)?.sandbox;
  const workspaceSandbox = (): SandboxDraft | undefined =>
    deps.settings.withheldWorkspaceFields?.().includes("sandbox")
      ? undefined
      : sandboxAt("workspace");
  const effectiveSandbox = (): SandboxDraft | undefined => {
    deps.settings.version();
    return deps.settings.effective().sandbox;
  };
  const hasValue = (value: unknown): boolean =>
    Array.isArray(value) ? value.length > 0 : value !== undefined;
  const fieldSource = (
    pick: (sandbox: SandboxDraft) => unknown,
    strategy: "last" | "union" = "last",
  ): string => {
    const global = hasValue(sandboxAt("global") ? pick(sandboxAt("global")!) : undefined);
    const workspace = hasValue(workspaceSandbox() ? pick(workspaceSandbox()!) : undefined);
    if (strategy === "union" && global && workspace) return "global + workspace";
    if (workspace) return "workspace";
    if (global) return "global";
    return "product default";
  };
  const blockSource = (): string => {
    if (workspaceSandbox()) return "workspace";
    if (sandboxAt("global")) return "global";
    return "product default";
  };

  return (
    <ViewFrame host={host} title="Sandbox">
      <box flexDirection="column" flexShrink={1} minHeight={0}>
        <StatusRow label="effective" text={effectiveStatus().text} fg={effectiveStatus().fg} />
        <Show
          when={!inspecting()}
          fallback={<LoadingHint text="checking Bubblewrap on kernel host" />}
        >
          <StatusRow label="host" text={hostText()} fg={hostColor()} />
        </Show>
        <Show when={hostWarning()}>
          <DetailLines indent rows={[{ text: hostWarning()!.text, fg: hostWarning()!.fg }]} />
        </Show>
        <box flexDirection="column" flexShrink={0} paddingBottom={1}>
          <DetailLines
            indent
            rows={[
              { text: "Bubblewrap applies to bash and monitor_start on Linux", fg: tokens.muted },
            ]}
          />
        </box>
        <SettingRow
          setting={{
            label: "Sandbox",
            configured: draft() ? (draft()!.enabled === false ? "off" : "on") : "inherit",
            effective: effectiveSandbox()?.enabled === false || !effectiveSandbox() ? "off" : "on",
            source: blockSource(),
            applies: "next run",
            mutation: "staged",
          }}
          selected={sel() === 0}
          expanded={sel() === 0}
        />
        <Show when={draft()}>
          <SettingRow
            setting={{
              label: "Host availability",
              configured: draft()!.availability ?? "inherit",
              effective: effectiveSandbox()?.availability ?? "required",
              source: fieldSource((sandbox) => sandbox.availability),
              applies: "next run",
              mutation: "staged",
            }}
            selected={sel() === 1}
            expanded={sel() === 1}
          />
          <SettingRow
            setting={{
              label: "Workspace access",
              configured: draft()!.filesystem ?? "inherit",
              effective: effectiveSandbox()?.filesystem ?? "workspace-write",
              source: fieldSource((sandbox) => sandbox.filesystem),
              applies: "next run",
              mutation: "staged",
            }}
            selected={sel() === 2}
            expanded={sel() === 2}
          />
          <SettingRow
            setting={{
              label: "Network access",
              configured: draft()!.network ?? "inherit",
              effective: effectiveSandbox()?.network ?? "host",
              source: fieldSource((sandbox) => sandbox.network),
              applies: "next run",
              mutation: "staged",
            }}
            selected={sel() === 3}
            expanded={sel() === 3}
          />
          <SettingRow
            setting={{
              label: "Allowed environment variables",
              configured: showConfiguredList(draft()!.pass_env),
              effective: showList(effectiveSandbox()?.pass_env),
              source: fieldSource((sandbox) => sandbox.pass_env, "union"),
              applies: "next run",
              mutation: "staged",
            }}
            selected={sel() === 4}
            expanded={sel() === 4}
          />
          <SettingRow
            setting={{
              label: "Toolchain discovery",
              configured: draft()!.toolchains?.mode ?? "inherit",
              effective: effectiveSandbox()?.toolchains?.mode ?? "auto",
              source: fieldSource((sandbox) => sandbox.toolchains?.mode),
              applies: "next run",
              mutation: "staged",
            }}
            selected={sel() === 5}
            expanded={sel() === 5}
          />
          <SettingRow
            setting={{
              label: "Included toolchains",
              configured: showConfiguredList(draft()!.toolchains?.include),
              effective: showList(effectiveSandbox()?.toolchains?.include),
              source: fieldSource((sandbox) => sandbox.toolchains?.include),
              applies: "next run",
              mutation: "staged",
            }}
            selected={sel() === 6}
            expanded={sel() === 6}
          />
          <SettingRow
            setting={{
              label: "Excluded toolchains",
              configured: showConfiguredList(draft()!.toolchains?.exclude),
              effective: showList(effectiveSandbox()?.toolchains?.exclude),
              source: fieldSource((sandbox) => sandbox.toolchains?.exclude, "union"),
              applies: "next run",
              mutation: "staged",
            }}
            selected={sel() === 7}
            expanded={sel() === 7}
          />
          <SettingRow
            setting={{
              label: "Additional toolchain paths",
              configured: showConfiguredList(draft()!.toolchains?.extra_paths),
              effective: showList(effectiveSandbox()?.toolchains?.extra_paths),
              source: fieldSource((sandbox) => sandbox.toolchains?.extra_paths, "union"),
              applies: "next run",
              mutation: "staged",
            }}
            selected={sel() === 8}
            expanded={sel() === 8}
          />
        </Show>
        <box flexDirection="column" flexShrink={0} paddingTop={1}>
          <Show when={!inspecting()} fallback={<LoadingHint text="discovering toolchains" />}>
            <Show
              when={inspectionError()}
              fallback={<text fg={tokens.muted}>Toolchains on kernel host</text>}
            >
              <ErrorBanner text={inspectionError()!} />
            </Show>
          </Show>
        </box>
        <scrollbox
          height={toolchainRows()}
          flexShrink={1}
          minHeight={0}
          verticalScrollbarOptions={scrollbarOptions()}
        >
          <text fg={tokens.muted} selectable={false}>
            {"Tool       Version             Manager   Source     State"}
          </text>
          <For each={visibleToolchains()}>
            {(toolchain) => (
              <text flexShrink={0} fg={toolchain.available ? tokens.add : tokens.muted}>
                {`${toolchain.id.padEnd(10)} ${(toolchain.version ?? glyph("emDash")).padEnd(19)} ${(toolchain.manager ?? glyph("emDash")).padEnd(9)} ${toolchain.scope.padEnd(10)} ${toolchain.available ? "Available" : "Unavailable"}`}
              </text>
            )}
          </For>
          <For each={inspection()?.extra_paths ?? []}>
            {(path) => (
              <text flexShrink={0} fg={path.available ? tokens.muted : tokens.warn}>
                {`${path.scope.padEnd(9)} ${path.path}${path.error ? ` (${path.error})` : ""}`}
              </text>
            )}
          </For>
          <Show when={!showUnavailable() && unavailableCount() > 0}>
            <text fg={tokens.muted} selectable={false}>
              {`${unavailableCount()} unavailable hidden ${glyph("separator")} u show unavailable`}
            </text>
          </Show>
        </scrollbox>
      </box>
      <Show when={fe.editing()}>{fe.EditInput()}</Show>
      {fe.PickerInput()}
    </ViewFrame>
  );
}
