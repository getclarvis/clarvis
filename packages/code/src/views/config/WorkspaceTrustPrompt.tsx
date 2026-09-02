import type { JSX } from "solid-js";
import { createSignal, For, onMount, Show } from "solid-js";
import type { ResolvedExtensionProfile } from "@clarvis/protocol";

import type { WorkspaceTrustState } from "../../adapters/settings.ts";
import { detachObserved } from "../../core/tasks.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import { tone } from "../../theme/tone.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { formatElapsed, spinnerChar, tickNow, useSpinnerClock } from "../spinner.ts";
import { bindLevelKeys, SectionHeader, ViewFrame } from "./view-host.tsx";

export interface WorkspaceTrustPromptDeps {
  state: () => WorkspaceTrustState;
  fields: () => readonly string[];
  extensionProfile: () => Promise<ResolvedExtensionProfile>;
  approve: () => Promise<void>;
  review: () => void;
  notify: (message: string, tone?: "success" | "warn" | "error") => void;
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  agents: "agents",
  enabledPlugins: "plugin selection",
  extensionProfile: "repository-owned plugins",
  hooks: "hooks",
  marketplaces: "marketplace sources",
  mcpServers: "MCP servers",
};

/** Proactive yes/review gate for a new or changed executable workspace snapshot. */
export function WorkspaceTrustPrompt(host: ViewHost, deps: WorkspaceTrustPromptDeps): JSX.Element {
  const [extensionProfile, setExtensionProfile] = createSignal<ResolvedExtensionProfile>();
  const [busy, setBusy] = createSignal(false);
  const [startedAt, setStartedAt] = createSignal<number>();
  const [failure, setFailure] = createSignal<string>();

  useSpinnerClock(() => busy() && host.active());
  onMount(() => {
    detachObserved("workspace_trust_extension_profile", () =>
      deps.extensionProfile().then(setExtensionProfile),
    );
  });

  const surface = (): string[] => {
    const labels = deps.fields().map((field) => FIELD_LABELS[field] ?? field);
    return [...new Set(labels.length > 0 ? labels : ["workspace agents or extensions"])];
  };

  const approve = (): void => {
    if (busy()) return;
    setFailure(undefined);
    setBusy(true);
    setStartedAt(Date.now());
    detachObserved(
      "workspace_trust_approve",
      async () => {
        await deps.approve();
        deps.notify("workspace snapshot approved and activated", "success");
        host.close();
      },
      (error) => {
        setBusy(false);
        setStartedAt(undefined);
        setFailure(error instanceof Error ? error.message : String(error));
      },
    );
  };

  const spec = (): LevelSpec => ({
    verbs: [
      {
        id: "workspace.trust.approve",
        key: "return",
        label: "yes, approve snapshot",
        run: approve,
        when: () => !busy(),
        hintGroup: "primary",
        hintPriority: 100,
        essential: true,
      },
      {
        id: "workspace.trust.review",
        key: "n",
        label: "no, review and remove",
        run: deps.review,
        when: () => !busy(),
        hintGroup: "navigation",
        hintPriority: 90,
      },
    ],
    escape: { label: "keep blocked", run: () => host.close() },
  });
  bindLevelKeys({
    host,
    suspend: busy,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  const footerStatus = () => {
    if (!busy()) return undefined;
    const running = tone("running", spinnerChar());
    const start = startedAt();
    return {
      glyph: running.glyph,
      glyphFg: running.fg,
      text:
        "Approving snapshot" +
        glyph("ellipsis") +
        (start === undefined ? "" : ` ${glyph("separator")} ${formatElapsed(tickNow() - start)}`),
      fg: tokens.muted,
    };
  };

  return (
    <ViewFrame host={host} title="Workspace approval" unscoped footerStatus={footerStatus}>
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <box flexDirection="column" maxWidth={92}>
          <text fg={tokens.warn} wrapMode="word">
            <b>
              {deps.state() === "changed"
                ? "This workspace's executable snapshot changed."
                : "This workspace wants to activate executable content."}
            </b>
          </text>
          <text fg={tokens.fg} wrapMode="word" paddingTop={1}>
            Approve this workspace once? Every repository-owned plugin in the current snapshot is
            covered automatically. Nothing withheld runs until you say yes.
          </text>
          <SectionHeader label="Current Extension Profile" />
          <Show when={extensionProfile() !== undefined}>
            <text fg={tokens.accent2}>{extensionProfile()!.id}</text>
            <text fg={tokens.muted} wrapMode="word">
              {`${extensionProfile()!.plugins.length} plugins ${glyph("separator")} ${extensionProfile()!.standalone_skills.length} standalone skills ${glyph("separator")} ${extensionProfile()!.counts.mcp_servers_active} MCP ${glyph("separator")} ${extensionProfile()!.counts.hooks_declared} hooks`}
            </text>
            <text fg={tokens.muted} wrapMode="word">
              {`Extension Profile fingerprint ${extensionProfile()!.fingerprint}`}
            </text>
          </Show>
          <For each={surface()}>
            {(label) => <text fg={tokens.warn}>{`${glyph("warning")} ${label}`}</text>}
          </For>
          <text fg={tokens.accent2} paddingTop={1} wrapMode="word">
            Enter approves the current workspace fingerprint once. Press n to open Extensions and
            remove what you do not want.
          </text>
          <Show when={failure()}>
            <text fg={tokens.del} paddingTop={1} wrapMode="word">
              {failure()}
            </text>
          </Show>
        </box>
      </box>
    </ViewFrame>
  );
}
