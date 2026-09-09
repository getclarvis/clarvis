import { createSignal, onCleanup, Show, type Accessor, type JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { HostedRunRef } from "@clarvis/protocol";
import type { ViewHost } from "../../keys/commands.ts";
import { detachObserved } from "../../core/tasks.ts";
import { tokens } from "../../theme/tokens.ts";
import {
  bindLevelKeys,
  SelectableList,
  SelectableRow,
  ViewFrame,
} from "../../views/config/view-host.tsx";
import { registerLevel } from "../../ui/patterns/level-keys.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import type { HintTone } from "../../views/hint.ts";
import type { BackgroundController } from "./controller.ts";

/** Live workspace discovery with explicit control takeover and a separate new-conversation choice. */
export function BackgroundView(
  host: ViewHost,
  deps: {
    backgrounds: BackgroundController;
    startup?: boolean;
    notify(message: string, tone?: HintTone): void;
  },
): JSX.Element {
  const [state, setState] = createStore<{ rows: HostedRunRef[] }>({ rows: [] });
  const [selection, setSelection] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  let closed = false;
  let refreshing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const selected = (): HostedRunRef | undefined => state.rows[selection()];
  const report = (error: unknown): void =>
    deps.notify(error instanceof Error ? error.message : String(error), "warn");
  const refresh = async (): Promise<void> => {
    if (closed || refreshing) return;
    refreshing = true;
    clearTimeout(timer);
    const id = selected()?.execution_id;
    const wasNew = !loading() && selection() === state.rows.length;
    try {
      const rows = (await deps.backgrounds.list())
        .filter((ref) => !deps.startup || ref.disconnect_policy === "continue")
        .sort(
          (a, b) =>
            Number(a.execution_state === "closed") - Number(b.execution_state === "closed") ||
            b.created_at - a.created_at,
        );
      if (closed) return;
      setState("rows", reconcile(rows, { key: "execution_id" }));
      const previous = rows.findIndex((row) => row.execution_id === id);
      setSelection(
        wasNew
          ? rows.length
          : previous < 0
            ? clampListIndex(selection(), rows.length + 1)
            : previous,
      );
      setFailure("");
    } catch (error) {
      if (!closed) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      refreshing = false;
      if (!closed) {
        setLoading(false);
        timer = setTimeout(() => detachObserved("background.refresh", refresh), 1000);
        timer.unref?.();
      }
    }
  };
  detachObserved("background.open", refresh);
  onCleanup(() => {
    closed = true;
    clearTimeout(timer);
  });
  const attach = (takeover = false): void => {
    if (loading() || busy()) return;
    const ref = selected();
    if (ref === undefined) {
      deps.backgrounds.newConversation();
      host.close();
      return;
    }
    if (ref.execution_state === "unknown") {
      deps.notify(
        "The host cannot confirm this run's outcome. Its saved history remains in Sessions.",
        "warn",
      );
      return;
    }
    detachObserved(
      "background.attach",
      async () => {
        if (takeover) {
          setBusy(true);
          try {
            if (
              !(await host.confirm({
                message: "Take control from the other TUI?",
                confirmLabel: "take control",
                detail: [
                  "Its pending approvals and previous control will be revoked.",
                  ref.execution_id,
                ],
              })) ||
              closed
            )
              return;
          } finally {
            if (!closed) setBusy(false);
          }
        }
        const result = deps.backgrounds.attach(ref.execution_id, takeover ? "takeover" : undefined);
        host.close();
        await result;
      },
      report,
    );
  };
  const cancel = (): void => {
    const ref = selected();
    if (ref === undefined || busy()) return;
    setBusy(true);
    detachObserved(
      "background.cancel",
      async () => {
        try {
          await deps.backgrounds.cancel(ref.execution_id);
          deps.notify(
            "Cancellation requested. The run remains listed until it physically closes.",
            "info",
          );
          await refresh();
        } finally {
          if (!closed) setBusy(false);
        }
      },
      report,
    );
  };
  bindLevelKeys({
    host,
    register: (enabled) =>
      registerLevel(host.interaction.keymap, {
        enabled,
        nav: {
          count: () => state.rows.length + 1,
          index: selection,
          setIndex: setSelection,
          activate: { label: "open", run: () => attach(), when: () => !loading() && !busy() },
        },
        verbs: [
          {
            key: "t",
            label: "take control",
            run: () => attach(true),
            when: () =>
              !busy() &&
              selected()?.control === "other" &&
              !["closed", "unknown"].includes(selected()?.execution_state ?? "closed"),
          },
          {
            key: "c",
            label: "cancel run",
            run: cancel,
            when: () =>
              !busy() &&
              selected() !== undefined &&
              selected()?.control !== "other" &&
              !["closed", "unknown"].includes(selected()?.execution_state ?? "closed"),
          },
          {
            key: "ctrl+r",
            label: "refresh",
            run: () => detachObserved("background.refresh", refresh),
          },
        ],
      }),
  });
  return (
    <ViewFrame
      host={host}
      unscoped
      title="Background runs"
      purpose={
        deps.startup
          ? "Return to previous work or start another conversation."
          : "Inspect this workspace's runs and return to their conversation."
      }
    >
      <Show when={loading()}>
        <text fg={tokens.muted}>Loading hosted runs…</text>
      </Show>
      <Show when={failure()}>
        <text fg={tokens.warn}>{failure()}</text>
      </Show>
      <SelectableList
        each={() => state.rows}
        sel={selection}
        idPrefix="background-"
        maxRows={5}
        empty={() => ({ text: "No hosted runs", hint: "" })}
        row={(ref, index) => (
          <SelectableRow selected={selection() === index()}>
            <span
              style={{ fg: tokens.muted }}
            >{`${ref.execution_state === "closed" ? (ref.outcome?.status ?? "closed") : ref.attention === "waiting_user" ? "waiting for you" : ref.execution_state} | ${ref.config.agent} | `}</span>
            <span style={{ fg: tokens.fg }}>{ref.title || ref.execution_id}</span>
          </SelectableRow>
        )}
      />
      <SelectableRow selected={selection() === state.rows.length}>
        <span style={{ fg: tokens.accent }}>Start another conversation</span>
      </SelectableRow>
      <Show when={selected()}>
        {(ref: Accessor<HostedRunRef>) => (
          <>
            <text
              fg={tokens.muted}
            >{`Run: ${ref().execution_id}\nSession: ${ref().session_id}\nStarted: ${new Date(ref().created_at).toLocaleString()}`}</text>
            <text
              fg={tokens.fg}
            >{`Agent: ${ref().config.agent} | model: ${ref().config.model ?? "configured"} | ${ref().config.runtime?.kind ?? "runtime unavailable"}`}</text>
            <text fg={tokens.muted}>
              {ref().execution_state === "closed"
                ? "Open the saved result."
                : ref().control === "other"
                  ? "Enter observes. Take control explicitly to steer or answer approvals."
                  : "Enter returns to the same run. No prompt or tool is repeated."}
            </text>
            <Show when={ref().recovery_error}>
              <text fg={tokens.warn}>{ref().recovery_error}</text>
            </Show>
          </>
        )}
      </Show>
    </ViewFrame>
  );
}
