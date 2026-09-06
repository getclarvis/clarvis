import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { InputRenderable } from "@opentui/core";
import { PLAN_REVIEW_ELICIT_KIND } from "../adapters/elicit-types.ts";
import type {
  ElicitCommandDetail,
  ElicitRequestParams,
  ElicitResult,
  WorkspaceMergeDetail,
} from "../adapters/elicit-types.ts";
import type { PlanActivity } from "../adapters/plan-projection.ts";
import { tokens } from "../theme/tokens.ts";
import { borderChars, glyph } from "../theme/glyphs.ts";
import { MEASURE_MAX_COLS } from "./blocks.tsx";
import type { Interaction } from "../keys/interaction.ts";
import { LAYER } from "../ui/patterns/level-keys.ts";
import { uiCommand } from "../keys/actions.ts";
import { ChoiceRows } from "./overlays/ChoiceRows.tsx";
import { ClampedCode } from "./tools/registry.tsx";
import {
  acceptResult,
  CANCEL_RESULT,
  DECLINE_RESULT,
  initialValues,
  missingRequired,
  parseElicitForm,
  type ElicitField,
} from "../adapters/elicitation.ts";

const isChoice = (f: ElicitField | undefined): f is ElicitField =>
  !!f && (f.kind === "select" || f.kind === "boolean") && f.options.length > 0;

function fieldLabel(name: string, title: string): string {
  if (name === "response" || title.toLowerCase() === "response") return "Your answer";
  const cleaned = title.replaceAll("_", " ").trim();
  return cleaned.length > 0 ? cleaned[0]!.toUpperCase() + cleaned.slice(1) : "Your answer";
}

/**
 * Renders one pending elicitation as a modal-style block: a guard confirmation,
 * a plan-review approval, a URL notice, or a generic agent question with
 * text/number/select/boolean fields.
 *
 * @remarks
 * A guard's structured command renders as highlighted code — the user is
 * approving THIS text — with the guard's reason (and any analyzer warning)
 * above it; the prose message is only the unstructured fallback.
 */
export function ElicitBlock(props: {
  interaction: Interaction;
  request: ElicitRequestParams;
  onResolve: (result: ElicitResult) => void;
  onNotify?: (message: string) => void;
  /** The run's live plan, used to summarize what is awaiting approval on a
   * `plan_review`. Absent for every other elicitation kind. */
  plan?: () => PlanActivity | null;
  /** Opens the plan overlay from the approval block. */
  onOpenPlan?: () => void;
  /** Uses the full width of a containing split pane instead of the reading cap. */
  fillAvailableWidth?: () => boolean;
}): JSX.Element {
  const form = parseElicitForm(props.request);
  const fields = form.fields;
  const isGuard = props.request.kind === "guard_confirm";
  const isPlanReview = props.request.kind === PLAN_REVIEW_ELICIT_KIND;
  const isWorkflowReview = props.request.kind === "workflow_review";
  const isWorkspaceMerge = props.request.kind === "workspace_merge";
  const accent = (): string =>
    isGuard
      ? tokens.warn
      : isPlanReview || isWorkflowReview || isWorkspaceMerge
        ? tokens.accent2
        : tokens.accent;

  /** `title` + `revision N · M tasks · retention: keep`, or null when the plan
   * projection has not arrived. */
  const planSummary = createMemo(() => {
    const plan = props.plan?.();
    if (!isPlanReview || !plan) return null;
    const sep = " " + glyph("separator") + " ";
    return {
      title: plan.title,
      meta: [
        `revision ${plan.spec_revision}`,
        `${plan.tasks.length} ${plan.tasks.length === 1 ? "task" : "tasks"}`,
        `retention: ${plan.retention === "keep" ? "keep" : "delete after success"}`,
      ].join(sep),
    };
  });
  /**
   * Whether to drop the engine's prose message.
   *
   * @remarks True only for a `plan_review` whose plan projection has arrived, in
   * which case the header, the plan summary and the relabelled decisions already
   * say everything the sentence said — and say it in the client's own words. The
   * elicitation declares `kind: "plan_review"` precisely so a UI can frame it
   * itself instead of relaying engine copy; `buildPlanReviewElicitParams()`
   * hard-codes English, which a headless caller still needs but a UI that has
   * framed the request does not. Falls back to the message while the projection
   * is in flight, so the block is never blank.
   */
  const suppressProse = createMemo(() => isPlanReview && planSummary() !== null);

  // A plan or workflow gate authorizes work. Unlike an ordinary choice question,
  // it must not silently choose a verdict from enum order: select first, then confirm.
  const init = initialValues(
    fields,
    isPlanReview || isWorkflowReview || isWorkspaceMerge ? "none" : "first",
  );
  const [values, setValues] = createSignal<Record<string, string>>(init);
  const [active, setActive] = createSignal(0);
  const inputs: Record<string, InputRenderable> = {};

  const activeField = (): ElicitField | undefined => fields[active()];
  const clampField = (i: number): number =>
    fields.length === 0 ? 0 : ((i % fields.length) + fields.length) % fields.length;

  function moveField(dir: number): void {
    if (fields.length < 2) return;
    setActive((i) => clampField(i + dir));
  }

  /** Index is derived from the answer itself: cursor, radio and submitted
   * value therefore update atomically and cannot disagree. */
  function choiceIndex(f: ElicitField): number {
    return f.options.findIndex((option) => option.value === values()[f.name]);
  }

  function setChoice(f: ElicitField, index: number): void {
    const next = Math.max(0, Math.min(f.options.length - 1, index));
    const option = f.options[next];
    if (option) setValues((current) => ({ ...current, [f.name]: option.value }));
  }

  function moveHighlight(dir: number): void {
    const f = activeField();
    if (!isChoice(f)) return;
    const current = choiceIndex(f);
    // An approval gate can start with no verdict. Its first directional action
    // selects a visible edge rather than wrapping an invisible cursor.
    const next =
      current < 0
        ? dir < 0
          ? f.options.length - 1
          : 0
        : Math.max(0, Math.min(f.options.length - 1, current + dir));
    setChoice(f, next);
  }

  function pickDigit(n: number): void {
    const f = activeField();
    if (!isChoice(f) || n > f.options.length) return;
    setChoice(f, n - 1);
  }

  function accept(): void {
    if (form.mode === "url") {
      props.onResolve(DECLINE_RESULT);
      return;
    }
    const merged = values();
    const miss = missingRequired(fields, merged);
    if (miss.length > 0) {
      const idx = fields.findIndex((f) => f.name === miss[0]);
      if (idx >= 0) setActive(idx);
      props.onNotify?.(`answer required: ${miss.join(", ")}`);
      return;
    }
    props.onResolve(acceptResult(fields, merged));
  }

  createEffect(() => {
    const f = activeField();
    const target = f && (f.kind === "text" || f.kind === "number") ? f.name : null;
    for (const [name, el] of Object.entries(inputs)) {
      if (name === target) el?.focus();
      else el?.blur();
    }
  });

  onMount(() => {
    const choiceCommands = Array.from({ length: 9 }, (_, index) =>
      uiCommand({
        id: `elicit.choice.${index + 1}`,
        title: `Choose option ${index + 1}`,
        description: `Select answer option ${index + 1}; confirm it with Enter`,
        category: "primary",
        surfaces: ["full-help"],
        run: () => pickDigit(index + 1),
      }),
    );
    const off = props.interaction.keymap.registerLayer({
      priority: LAYER.MODAL,
      commands: [
        uiCommand({
          id: "elicit.choice.previous",
          title: "Select previous choice",
          description: "Select the previous answer choice without confirming it",
          category: "navigation",
          surfaces: ["footer"],
          footerLabel: "select",
          hintPriority: 60,
          hintGroup: "navigation",
          run: () => moveHighlight(-1),
        }),
        uiCommand({
          id: "elicit.choice.next",
          title: "Select next choice",
          description: "Select the next answer choice without confirming it",
          category: "navigation",
          surfaces: ["full-help"],
          run: () => moveHighlight(1),
        }),
        uiCommand({
          id: "elicit.field.next",
          title: "Next field",
          description: "Move to the next answer field",
          category: "navigation",
          surfaces: fields.length > 1 ? ["footer"] : ["internal"],
          footerLabel: "next field",
          hintPriority: 55,
          hintGroup: "navigation",
          run: () => moveField(1),
        }),
        uiCommand({
          id: "elicit.field.previous",
          title: "Previous field",
          description: "Move to the previous answer field",
          category: "navigation",
          surfaces: fields.length > 1 ? ["full-help"] : ["internal"],
          run: () => moveField(-1),
        }),
        uiCommand({
          id: "elicit.accept",
          title: isGuard
            ? "Confirm command decision"
            : isPlanReview
              ? "Confirm plan decision"
              : isWorkflowReview
                ? "Confirm workflow decision"
                : isWorkspaceMerge
                  ? "Confirm workspace merge decision"
                  : "Send answer",
          description: isGuard
            ? "Confirm the selected decision for this exact command"
            : isPlanReview || isWorkflowReview || isWorkspaceMerge
              ? "Confirm the selected decision"
              : "Send the current answer",
          category: "primary",
          surfaces: form.mode === "url" ? ["internal"] : ["footer"],
          footerLabel:
            isGuard || isPlanReview || isWorkflowReview || isWorkspaceMerge ? "confirm" : "send",
          hintPriority: 100,
          hintGroup: "primary",
          essential: true,
          run: accept,
        }),
        ...(isPlanReview && props.onOpenPlan
          ? [
              uiCommand({
                id: "elicit.plan.open",
                title: "Open plan",
                description: "Inspect the full plan before deciding",
                category: "navigation",
                surfaces: ["footer"],
                footerLabel: "open plan",
                hintPriority: 70,
                hintGroup: "navigation",
                run: props.onOpenPlan,
              }),
            ]
          : []),
        uiCommand({
          id: "elicit.decline",
          title: isGuard
            ? "Deny command"
            : isWorkflowReview
              ? "Do not run workflow"
              : isWorkspaceMerge
                ? "Keep changes pending"
                : "Decline request",
          description: isGuard ? "Deny this exact command" : "Decline without cancelling the run",
          category: "mutation",
          surfaces: ["footer"],
          footerLabel: isGuard
            ? "deny"
            : isWorkflowReview
              ? "do not run"
              : isWorkspaceMerge
                ? "keep pending"
                : "decline",
          hintPriority: 80,
          hintGroup: "mutation",
          run: () => props.onResolve(DECLINE_RESULT),
        }),
        uiCommand({
          id: "elicit.cancel",
          title: isPlanReview || isWorkspaceMerge ? "Cancel run" : "Cancel request",
          description:
            isPlanReview || isWorkspaceMerge ? "Cancel the active run" : "Cancel this interaction",
          category: "escape",
          surfaces: ["footer"],
          footerLabel: isPlanReview || isWorkspaceMerge ? "cancel run" : "cancel",
          hintPriority: 90,
          hintGroup: "escape",
          essential: true,
          run: () => props.onResolve(CANCEL_RESULT),
        }),
        ...choiceCommands,
      ],
      bindings: [
        { key: "up", cmd: "elicit.choice.previous" },
        { key: "down", cmd: "elicit.choice.next" },
        ...Array.from({ length: 9 }, (_, i) => ({
          key: String(i + 1),
          cmd: `elicit.choice.${i + 1}`,
        })),
        { key: "tab", cmd: "elicit.field.next" },
        { key: "shift+tab", cmd: "elicit.field.previous" },
        { key: "return", cmd: "elicit.accept" },
        ...(isPlanReview && props.onOpenPlan ? [{ key: "ctrl+p", cmd: "elicit.plan.open" }] : []),
        { key: "ctrl+x", cmd: "elicit.decline" },
        { key: "escape", cmd: "elicit.cancel" },
      ],
    });
    onCleanup(off);
  });

  return (
    <box
      id="active-elicitation"
      flexDirection="column"
      flexShrink={0}
      width="100%"
      maxWidth={props.fillAvailableWidth?.() ? "100%" : MEASURE_MAX_COLS}
      marginTop={1}
      paddingLeft={1}
      paddingRight={1}
      borderStyle="rounded"
      customBorderChars={borderChars()}
      borderColor={accent()}
      backgroundColor={tokens.bg}
    >
      <text fg={accent()} flexShrink={0}>
        {isGuard
          ? glyph("warning") + " Command approval"
          : isPlanReview
            ? "Plan approval required"
            : isWorkflowReview
              ? "Workflow approval required"
              : isWorkspaceMerge
                ? "Workspace merge approval required"
                : "Agent asks"}
      </text>
      <Show when={planSummary()} keyed>
        {(summary: { title: string; meta: string }) => (
          <box paddingTop={1} flexDirection="column" flexShrink={0}>
            <text fg={tokens.fg}>{summary.title}</text>
            <text fg={tokens.muted}>{summary.meta}</text>
          </box>
        )}
      </Show>
      <box paddingTop={1} flexDirection="column" flexShrink={0}>
        <Show
          when={form.detail}
          keyed
          fallback={
            <Show when={!suppressProse()}>
              <text fg={tokens.fg} wrapMode="word">
                {form.message}
              </text>
            </Show>
          }
        >
          {(detail: ElicitCommandDetail) => (
            <box flexDirection="column" flexShrink={0}>
              <text fg={tokens.fg}>{detail.reason}</text>
              <Show when={detail.warning} keyed>
                {(warning: string) => <text fg={tokens.warn}>{warning}</text>}
              </Show>
              <ClampedCode content={detail.command} filetype="bash" full wrap="char" />
              <text fg={tokens.muted}>{"in " + detail.cwd}</text>
            </box>
          )}
        </Show>
      </box>
      <Show when={form.workspaceMerge} keyed>
        {(merge: WorkspaceMergeDetail) => (
          <box paddingTop={1} flexDirection="column" flexShrink={0}>
            <text
              fg={tokens.fg}
            >{`${merge.changes.length} reviewed workspace change${merge.changes.length === 1 ? "" : "s"}`}</text>
            <For each={merge.changes}>
              {(change) => (
                <text fg={tokens.muted} wrapMode="word">
                  {`${change.action.padEnd(6)} ${change.path}${change.type === "symlink" ? ` -> ${change.target ?? ""}` : ""}`}
                </text>
              )}
            </For>
            <text fg={tokens.muted}>{`change set ${merge.change_set_id}`}</text>
          </box>
        )}
      </Show>

      <Show when={form.mode === "url"}>
        <box paddingTop={1} flexShrink={0}>
          <text fg={tokens.muted}>{"Open this URL to continue:"}</text>
          <text fg={tokens.accent2}>{form.url ?? ""}</text>
        </box>
      </Show>

      <box paddingTop={1} flexDirection="column" flexShrink={0}>
        <For each={fields}>
          {(f, i) => {
            const on = (): boolean => i() === active();
            return (
              <box flexDirection="column" paddingTop={i() === 0 ? 0 : 1} flexShrink={0}>
                <text selectable={false}>
                  <span style={{ fg: on() ? tokens.accent : tokens.muted }}>
                    {on() ? glyph("chevronRight") + " " : "  "}
                  </span>
                  <span style={{ fg: on() ? tokens.fg : tokens.muted }}>
                    {fieldLabel(f.name, f.title)}
                  </span>
                  <span style={{ fg: f.required ? tokens.warn : tokens.muted }}>
                    {f.required ? " — required" : " — optional"}
                  </span>
                </text>
                <Show when={f.description}>
                  <text fg={tokens.muted} wrapMode="word" paddingLeft={2} selectable={false}>
                    {f.description}
                  </text>
                </Show>

                <Show when={isChoice(f)}>
                  <box paddingLeft={2} flexDirection="column" flexShrink={0}>
                    <ChoiceRows
                      choices={f.options.map((o, oi) => ({
                        value: o.value,
                        label: oi < 9 ? `[${oi + 1}] ${o.label}` : o.label,
                        description: oi < 9 ? "number shortcut" : "",
                      }))}
                      selected={() => choiceIndex(f)}
                      labelWidth={Math.max(
                        ...f.options.map((o, index) => o.label.length + (index < 9 ? 4 : 0)),
                      )}
                      base={tokens.bg}
                      onSelect={(index) => {
                        setActive(i());
                        setChoice(f, index);
                      }}
                      onConfirm={accept}
                    />
                  </box>
                </Show>

                <Show when={f.kind === "text" || f.kind === "number"}>
                  <box
                    border
                    borderStyle="rounded"
                    customBorderChars={borderChars()}
                    borderColor={on() ? tokens.accent : tokens.muted}
                    paddingLeft={1}
                    marginLeft={2}
                    flexShrink={0}
                  >
                    <input
                      ref={(el: InputRenderable) => {
                        inputs[f.name] = el;
                        el.value = values()[f.name] ?? "";
                        el.onContentChange = () => setValues({ ...values(), [f.name]: el.value });
                      }}
                      placeholder={
                        f.kind === "number"
                          ? "number" + glyph("ellipsis")
                          : "type your answer" + glyph("ellipsis")
                      }
                      placeholderColor={tokens.muted}
                      textColor={tokens.fg}
                      focusedTextColor={tokens.fg}
                    />
                  </box>
                </Show>
              </box>
            );
          }}
        </For>
      </box>
    </box>
  );
}
