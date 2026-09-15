import { createSignal, onCleanup, Show, type Accessor, type JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ViewHost } from "../../keys/commands.ts";
import { loopScheduleLabel } from "../../core/loop-schedule.ts";
import { tokens } from "../../theme/tokens.ts";
import {
  bindLevelKeys,
  SelectableList,
  SelectableRow,
  ViewFrame,
} from "../../views/config/view-host.tsx";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import type { HintTone } from "../../views/hint.ts";
import type { LoopController, LoopJob } from "./controller.ts";

const instant = (value: number | undefined): string =>
  value === undefined ? "-" : new Date(value).toISOString();

/** Inspect and control the live conversation's jobs without rewriting its transcript. */
export function LoopView(
  host: ViewHost,
  deps: {
    loops: LoopController;
    initialId?: string;
    notify(message: string, tone?: HintTone): void;
  },
): JSX.Element {
  const [state, setState] = createStore<{ jobs: LoopJob[] }>({ jobs: [] });
  const sync = (): void =>
    setState("jobs", reconcile(structuredClone([...deps.loops.list()]), { key: "id" }));
  sync();
  onCleanup(deps.loops.subscribe(sync));
  const jobs = (): readonly Readonly<LoopJob>[] => state.jobs;
  const [selection, setSelection] = createSignal(0);
  const [detailId, setDetailId] = createSignal<string | undefined>(deps.initialId);
  let scroll: ScrollBoxRenderable | undefined;
  const selected = (): Readonly<LoopJob> | undefined =>
    detailId()
      ? jobs().find((job) => job.id === detailId())
      : jobs()[clampListIndex(selection(), jobs().length)];
  const act = (operation: (id: string) => void): void => {
    const job = selected();
    if (!job) return;
    try {
      operation(job.id);
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), "warn");
    }
  };
  const spec = (): LevelSpec => ({
    ...(detailId()
      ? { scroll: () => scroll, escape: { label: "loops", run: () => setDetailId(undefined) } }
      : {
          nav: {
            count: () => jobs().length,
            index: selection,
            setIndex: setSelection,
            activate: { label: "details", run: () => setDetailId(selected()?.id) },
          },
        }),
    verbs: [
      {
        key: "p",
        label: "pause",
        when: () => selected()?.state === "scheduled",
        run: () => act((id) => deps.loops.pause(id)),
      },
      {
        key: "r",
        label: "resume",
        when: () => selected()?.state === "paused" && !selected()?.active,
        run: () =>
          act((id) => {
            deps.loops.resume(id);
            setDetailId(id);
          }),
      },
      {
        key: "c",
        label: "cancel loop",
        when: () => ["scheduled", "paused"].includes(selected()?.state ?? ""),
        run: () => act((id) => deps.loops.cancel(id)),
      },
      {
        key: "x",
        label: "cancel loop + run",
        when: () => selected()?.active !== undefined,
        run: () => act((id) => deps.loops.cancel(id, true)),
      },
    ],
  });
  bindLevelKeys({
    host,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });
  return (
    <ViewFrame
      host={host}
      title="Loops"
      unscoped
      purpose="Prompts run between turns while this TUI stays open."
    >
      <Show
        when={detailId() && selected()}
        fallback={
          <>
            <SelectableList
              each={jobs}
              sel={selection}
              idPrefix="loop-"
              maxRows={6}
              empty={() => ({
                text: "No loops in this conversation",
                hint: "",
              })}
              row={(job, index) => (
                <SelectableRow selected={selection() === index()}>
                  <span style={{ fg: tokens.fg }}>{job.id}</span>
                  <span
                    style={{ fg: tokens.muted }}
                  >{`  ${job.state}${job.active ? " | running" : job.pending ? " | pending" : ""}  ${job.admittedRuns}/${job.maxRuns}  ${job.binding.agentId}`}</span>
                </SelectableRow>
              )}
            />
            <text fg={tokens.muted} flexShrink={0}>
              {"/loop 5m <prompt>  |  /loop 90m --max-runs 8 -- <prompt>\n" +
                '/loop cron "0 9 * * 1-5" --tz America/Recife -- <prompt>\n' +
                "list | show <id> | pause <id> | resume <id> | cancel <id> [--running]\n" +
                "Intervals wait after completion. Cron keeps its calendar; missed times coalesce.\n" +
                "Default: 20 attempts; up to 10 live jobs here. Switching conversations pauses them.\n" +
                "Cron: five numeric fields, *, lists, ranges and steps; Sunday 0/7.\n" +
                "Restricted day + weekday use OR. DST gaps skip; repeats use the first occurrence.\n" +
                'Options require -- before the literal prompt. Only cron quotes use \\" or \\\\ escapes.\n' +
                "Closing the TUI forgets registrations. Normal run history remains."}
            </text>
          </>
        }
      >
        {(job: Accessor<Readonly<LoopJob>>) => (
          <scrollbox
            ref={(value: ScrollBoxRenderable) => {
              scroll = value;
            }}
            flexGrow={1}
            minHeight={0}
            verticalScrollbarOptions={scrollbarOptions()}
          >
            <text fg={tokens.accent}>{job().id}</text>
            <text
              fg={tokens.fg}
            >{`State: ${job().state}${job().pauseReason ? `: ${job().pauseReason}` : ""}`}</text>
            <text
              fg={tokens.fg}
            >{`Agent: ${job().binding.agentId} | ${job().binding.configLabel}`}</text>
            <text fg={tokens.muted}>{`Session: ${job().binding.sessionId}`}</text>
            <text fg={tokens.fg}>{`Schedule: ${loopScheduleLabel(job().schedule)}`}</text>
            <text
              fg={tokens.fg}
            >{`Next eligible: ${instant(job().nextDueAt)} | attempts ${job().admittedRuns}/${job().maxRuns}`}</text>
            <Show when={job().pending}>
              {(pending: Accessor<NonNullable<LoopJob["pending"]>>) => (
                <text
                  fg={tokens.warn}
                >{`Pending: ${instant(pending().scheduledAt)}; waiting for the conversation.`}</text>
              )}
            </Show>
            <Show when={job().active}>
              {(active: Accessor<NonNullable<LoopJob["active"]>>) => (
                <>
                  <text fg={tokens.accent}>{`Active: ${active().executionId}`}</text>
                  <text
                    fg={tokens.muted}
                  >{`Due: ${instant(active().scheduledAt)} | admitted: ${instant(active().admittedAt)}`}</text>
                  <Show when={active().cancellation}>
                    <text
                      fg={tokens.warn}
                    >{`Cancellation: ${active().cancellation}${active().cancellationError ? `: ${active().cancellationError}` : "; awaiting physical completion"}`}</text>
                  </Show>
                </>
              )}
            </Show>
            <Show when={job().lastResult}>
              {(result: Accessor<NonNullable<LoopJob["lastResult"]>>) => (
                <text
                  fg={tokens.muted}
                >{`Last result: ${result().status} at ${instant(result().completedAt)}${result().reason ? `: ${result().reason}` : ""}`}</text>
              )}
            </Show>
            <text
              fg={tokens.muted}
            >{`Usage: input ${job().usage.input ?? "unknown"}, output ${job().usage.output ?? "unknown"}; cost ${job().usage.costUsd === undefined ? "unavailable" : `$${job().usage.costUsd!.toFixed(4)}`}`}</text>
            <text fg={tokens.accent} marginTop={1}>
              Prompt
            </text>
            <text fg={tokens.fg}>{job().prompt}</text>
          </scrollbox>
        )}
      </Show>
    </ViewFrame>
  );
}
