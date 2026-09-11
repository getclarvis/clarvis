import { createEffect, createSignal, on, onCleanup, Show, type Accessor, type JSX } from "solid-js";
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
import { createBackgroundListController, type BackgroundController } from "./controller.ts";

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
  const list = createBackgroundListController({
    backgrounds: deps.backgrounds,
    ...(deps.startup === undefined ? {} : { startup: deps.startup }),
    emit: () =>
      deps.notify(
        "Cancellation requested. The run remains listed until it physically closes.",
        "info",
      ),
  });
  const { loading, busy, failure, refresh } = list;
  const selected = (): HostedRunRef | undefined => state.rows[selection()];
  const report = (error: unknown): void =>
    deps.notify(error instanceof Error ? error.message : String(error), "warn");
  let listed = false;
  createEffect(
    on(
      list.rows,
      (rows) => {
        const id = selected()?.execution_id;
        const wasNew = listed && selection() === state.rows.length;
        setState("rows", reconcile(rows, { key: "execution_id" }));
        const previous = rows.findIndex((row) => row.execution_id === id);
        setSelection(
          wasNew
            ? rows.length
            : previous < 0
              ? clampListIndex(selection(), rows.length + 1)
              : previous,
        );
        listed = true;
      },
      { defer: true },
    ),
  );
  detachObserved("background.open", refresh);
  onCleanup(list.dispose);
  const attach = (takeover = false): void => {
    if (loading() || busy()) return;
    const ref = selected();
    if (ref === undefined) {
      deps.backgrounds.newConversation();
      host.close();
      return;
    }
    detachObserved(
      "background.attach",
      () =>
        list.attach(ref, {
          started: () => host.close(),
          ...(takeover
            ? {
                confirmTakeover: () =>
                  host.confirm({
                    message: "Take control from the other TUI?",
                    confirmLabel: "take control",
                    detail: [
                      "Its pending approvals and previous control will be revoked.",
                      ref.execution_id,
                    ],
                  }),
              }
            : {}),
        }),
      report,
    );
  };
  const cancel = (): void => {
    const ref = selected();
    if (ref !== undefined)
      detachObserved("background.cancel", () => list.cancel(ref.execution_id), report);
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
            key: "a",
            label: "archive recovery",
            when: () =>
              !busy() &&
              (selected()?.execution_state === "unknown" ||
                selected()?.recovery_resolution !== undefined),
            run: () => {
              const ref = selected();
              if (ref === undefined) return;
              detachObserved(
                "background.recovery",
                async () => {
                  await list.resolveRecovery(ref, () =>
                    host.confirm({
                      message: "Confirm all physical work has stopped?",
                      confirmLabel: "verify and archive",
                      detail: [
                        "Verify that every process and container from this old host has stopped before confirming.",
                        `Host: ${ref.host_generation} | run: ${ref.execution_id}`,
                        "The recorded outcome is preserved. This conversation will be archived; new work requires a new conversation.",
                        "Saved history and the operator confirmation are retained. No action is repeated.",
                      ],
                    }),
                  );
                },
                report,
              );
            },
          },
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
              {ref().execution_state === "unknown"
                ? "Verify the old host's processes and containers have stopped, then archive recovery."
                : ref().recovery_resolution !== undefined
                  ? "Physical closure was confirmed. Saved history is retained and the conversation is archived."
                  : ref().execution_state === "closed"
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
