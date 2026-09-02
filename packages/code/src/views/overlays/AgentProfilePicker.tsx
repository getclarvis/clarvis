import { createSignal, Show, type Accessor, type JSX } from "solid-js";
import type { Scope } from "@clarvis/protocol";
import { tokens } from "../../theme/tokens.ts";
import type { AgentProfileView } from "../../adapters/agents.ts";
import { deriveAgentShape, grantBadges } from "../../adapters/agents.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { glyph, glyphColWidth } from "../../theme/glyphs.ts";
import { ListPicker } from "./ListPicker.tsx";

const ACTIVE_COL_WIDTH = glyphColWidth("radioOn");
const MODEL_COL_WIDTH = 18;
/**
 * Width the model column collapses to when every profile inherits the session
 * model.
 *
 * @remarks The column then held `(inherited model)` on every row — a constant,
 *   so it carried no information while squeezing the grants beside it into a
 *   middle elision. It is spent only when a profile actually names a model.
 */
const MODEL_COL_COLLAPSED = 0;
const LEAD_COL_WIDTH = 4;
const GRANTS_COL_WIDTH = 32;

/** Agent defaults stored at each code-config scope. Workspace wins when both exist. */
export interface AgentDefaults {
  global?: string;
  workspace?: string;
}

interface DefaultScopeChoice {
  scope: Scope;
  label: string;
  detail: string;
}

const DEFAULT_SCOPE_CHOICES: readonly DefaultScopeChoice[] = [
  {
    scope: "global",
    label: "Global",
    detail: "all workspaces without a local override",
  },
  {
    scope: "workspace",
    label: "Workspace",
    detail: "this workspace only; overrides global",
  },
];

/**
 * A {@link ListPicker} of agent profiles, showing which one is currently
 * active, its model, whether it can lead sub-agents, and its grant badges.
 */
export function AgentProfilePicker(props: {
  interaction: Interaction;
  list: () => AgentProfileView[];
  active: () => string;
  defaults: () => AgentDefaults;
  enabled?: Accessor<boolean>;
  onConfirm: (name: string) => void;
  /**
   * Whether a profile can actually run under the current settings.
   *
   * @remarks Offering a profile that cannot run, with nothing said, is
   *   invariant 2 read backwards: the row is selectable and the failure only
   *   arrives after a prompt has been sent. Omitted, every profile is treated
   *   as runnable, which is the right default for a caller that cannot tell.
   */
  isRunnable?: (name: string) => boolean;
  onSetDefault: (name: string, scope: Scope) => boolean;
  onClearDefault: (scope: Scope) => boolean;
}): JSX.Element {
  const [pendingDefault, setPendingDefault] = createSignal<string | null>(null);
  const effectiveDefault = (): string | undefined =>
    props.defaults().workspace ?? props.defaults().global;
  const defaultSource = (): Scope | undefined =>
    props.defaults().workspace !== undefined
      ? "workspace"
      : props.defaults().global !== undefined
        ? "global"
        : undefined;
  const scopedDefault = (scope: Scope): string | undefined => props.defaults()[scope];
  const runnable = (name: string): boolean => props.isRunnable?.(name) ?? true;
  const anyOwnModel = (): boolean => props.list().some((p) => p.model !== undefined);
  const modelWidth = (): number => (anyOwnModel() ? MODEL_COL_WIDTH : MODEL_COL_COLLAPSED);
  const grantsWidth = (): number =>
    GRANTS_COL_WIDTH + (MODEL_COL_WIDTH - modelWidth()) + (anyOwnModel() ? 0 : 2);

  return (
    <Show
      when={pendingDefault()}
      keyed
      fallback={
        <ListPicker<AgentProfileView>
          keymap={props.interaction.keymap}
          active={props.enabled}
          title="Select Agent Profile"
          items={props.list}
          initialIndex={Math.max(
            0,
            props.list().findIndex((p) => p.name === props.active()),
          )}
          idPrefix="agent-"
          confirmLabel="switch agent"
          onConfirm={(p) => props.onConfirm(p.name)}
          verbs={[{ key: "s", label: "set default", run: (p) => setPendingDefault(p.name) }]}
          empty={() => ({
            text: "no agents",
            icon: "info",
            hint: "define agents in your .clarvis fleet",
          })}
          cells={(p, selected) => [
            {
              width: ACTIVE_COL_WIDTH,
              fg: p.name === props.active() ? tokens.accent : tokens.muted,
              text: p.name === props.active() ? glyph("radioOn") : glyph("radioOff"),
            },
            {
              grow: true,
              fg: runnable(p.name) ? (selected() ? tokens.fg : tokens.muted) : tokens.warn,
              text:
                `${p.name}${p.name === effectiveDefault() ? " · default" : ""}` +
                (runnable(p.name) ? "" : " · not runnable"),
            },
            ...(anyOwnModel() ? [{ width: modelWidth(), marginLeft: 2, text: p.model ?? "" }] : []),
            {
              width: LEAD_COL_WIDTH,
              marginLeft: 2,
              fg: tokens.accent2,
              text: deriveAgentShape(p).isLead ? "Lead" : "",
            },
            { width: grantsWidth(), marginLeft: 2, text: grantBadges(p.grants, grantsWidth()) },
          ]}
          preview={(profile) => (
            <box flexDirection="column">
              <text fg={tokens.fg} height={1} wrapMode="none" truncate>
                {profile.description ?? "No description provided."}
              </text>
              <text fg={tokens.muted} height={1} wrapMode="none" truncate selectable={false}>
                {`${profile.name === props.active() ? "Current session agent" : "Available agent"}${profile.name === effectiveDefault() ? ` · ${defaultSource()} default` : ""} · Enter switches`}
              </text>
            </box>
          )}
        />
      }
    >
      {(name: string) => (
        <ListPicker<DefaultScopeChoice>
          keymap={props.interaction.keymap}
          active={props.enabled}
          title={`Set ${name} as default`}
          items={() => [...DEFAULT_SCOPE_CHOICES]}
          initialIndex={props.defaults().workspace !== undefined ? 1 : 0}
          idPrefix="agent-default-scope-"
          confirmLabel="save default"
          escLabel="back"
          onClose={() => setPendingDefault(null)}
          onConfirm={(choice) => {
            if (props.onSetDefault(name, choice.scope)) setPendingDefault(null);
          }}
          verbs={[
            {
              key: "x",
              label: "clear default",
              run: (choice) => {
                if (props.onClearDefault(choice.scope)) setPendingDefault(null);
              },
            },
          ]}
          cells={(choice, selected) => [
            { width: 12, fg: selected() ? tokens.fg : tokens.muted, text: choice.label },
            { grow: true, marginLeft: 2, text: choice.detail },
            {
              marginLeft: 2,
              fg: scopedDefault(choice.scope) ? tokens.accent2 : tokens.muted,
              text: scopedDefault(choice.scope) ?? "not set",
            },
          ]}
          preview={(choice) => (
            <text fg={tokens.muted} height={1} wrapMode="none" truncate selectable={false}>
              {scopedDefault(choice.scope)
                ? `${choice.label} currently defaults to ${scopedDefault(choice.scope)}.`
                : `${choice.label} has no configured default.`}
            </text>
          )}
        />
      )}
    </Show>
  );
}
