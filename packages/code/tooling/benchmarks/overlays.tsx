#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { testRender } from "@opentui/solid";
import { createTestKeymap } from "@opentui/keymap/testing";
import { createSignal, For, Show, type Accessor, type JSX } from "solid-js";
import type { BaseRenderable } from "@opentui/core";
import { FloatFrame } from "../../src/views/overlays/FloatFrame.tsx";
import { AutocompletePopup } from "../../src/views/input/AutocompletePopup.tsx";
import { PageFrame } from "../../src/views/PageFrame.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import { ActivityDetail } from "../../src/views/overlays/ActivityDetail.tsx";
import { WorktreeExitPrompt } from "../../src/views/overlays/WorktreeExitPrompt.tsx";
import { ProfilePicker } from "../../src/views/overlays/ProfilePicker.tsx";
import { SafetyPresetPicker } from "../../src/views/overlays/SafetyPresetPicker.tsx";
import { CatalogPicker } from "../../src/views/config/CatalogPicker.tsx";
import { ElicitBlock } from "../../src/views/ElicitBlock.tsx";
import { HintToast } from "../../src/views/Footer.tsx";
import { Sidebar } from "../../src/views/Sidebar.tsx";
import { Splash } from "../../src/views/Splash.tsx";
import type { ActivityStore } from "../../src/adapters/activity-store.ts";
import type { ElicitRequestParams } from "../../src/adapters/elicit-types.ts";
import type { AgentProfileView } from "../../src/adapters/agents.ts";
import type { GuardModeStore } from "../../src/adapters/guard-mode.ts";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { WorkflowsHub } from "../../src/views/config/WorkflowsHub.tsx";
import {
  SurfaceBoundary,
  SurfacePortal,
  SurfaceRegion,
} from "../../src/ui/patterns/surface-lifecycle.tsx";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const cycles = positiveInteger(process.env.OVERLAY_SOAK_CYCLES, 100);
const batchSize = positiveInteger(process.env.OVERLAY_SOAK_BATCH, 20);
const warmupCycles = positiveInteger(process.env.OVERLAY_SOAK_WARMUP, 10);
const width = positiveInteger(process.env.OVERLAY_SOAK_WIDTH, 120);
const height = positiveInteger(process.env.OVERLAY_SOAK_HEIGHT, 32);
const maxMiBPer100 = positiveNumber(process.env.OVERLAY_SOAK_MAX_MIB_PER_100, 5);
const watchdogMs = positiveInteger(process.env.OVERLAY_SOAK_WATCHDOG_MS, 120_000);
const watchdogRssBytes =
  positiveInteger(process.env.OVERLAY_SOAK_WATCHDOG_RSS_MB, 1024) * 1024 * 1024;

interface MemorySample {
  cycle: number;
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  pss: number | null;
  privateDirty: number | null;
  renderables: number;
  lifecyclePasses: number;
  keyLayers: number;
  keyLayerRegistrations: number;
}

interface CaseResult {
  name: string;
  runtime: {
    bun: string;
    opentui: string;
    width: number;
    height: number;
    nativeRender: boolean;
  };
  warmupCycles: number;
  cycles: number;
  batchSize: number;
  samples: MemorySample[];
  growth: Omit<MemorySample, "cycle">;
  rssMiBPer100: number;
  pssMiBPer100: number | null;
  privateDirtyMiBPer100: number | null;
}

interface SoakCase {
  name: string;
  portal?: boolean;
  render(open: Accessor<boolean>): JSX.Element;
  advance?: (cycle: number) => void;
}

const keymapHarness = createTestKeymap({ defaultKeys: true });
const keymapCounters = { live: 0, registrations: 0 };
const registerKeyLayer = keymapHarness.keymap.registerLayer.bind(keymapHarness.keymap);
const trackedRegisterKeyLayer: typeof keymapHarness.keymap.registerLayer = (...args) => {
  keymapCounters.live += 1;
  keymapCounters.registrations += 1;
  const dispose = registerKeyLayer(...args);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    keymapCounters.live -= 1;
    dispose();
  };
};
const trackedKeymap = new Proxy(keymapHarness.keymap, {
  get(target, property) {
    if (property === "registerLayer") return trackedRegisterKeyLayer;
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const fakeInteraction = {
  keymap: trackedKeymap,
  pushOverlayContext: () => {},
  popOverlayContext: () => {},
} as unknown as Interaction;

const profiles = Array.from({ length: 30 }, (_, index): AgentProfileView => ({
  name: `agent-${index}`,
  model: index % 3 === 0 ? `provider/model-${index}` : undefined,
  canSpawn: index % 2 === 0 ? ["worker"] : [],
  grants: index % 2 === 0 ? ["read_workspace", "edit_workspace"] : ["read_workspace"],
}));

const catalogRows = Array.from({ length: 100 }, (_, index) => ({
  id: `provider-${index}`,
  label: `provider-${index}`,
  haystack: `provider-${index} model catalog`,
  detail: `provider kind · ${index + 1} models`,
}));

const safetySettings = {
  effective: () => ({
    guard: { type: "shell", mode: "auto" as const },
    sandbox: { enabled: true },
  }),
  read: () => undefined,
  write: async () => {},
} as unknown as SettingsAdapter;
const safetyGuard = {
  mode: () => "auto" as const,
  setMode: () => {},
  cycle: () => "auto" as const,
} satisfies GuardModeStore;

const guardRequest: ElicitRequestParams = {
  kind: "guard_confirm",
  message: "command requires approval\n\n$ bun test",
  requestedSchema: {
    type: "object",
    properties: { decision: { type: "string", enum: ["deny", "allow", "allow_session"] } },
    required: ["decision"],
  },
};

const sidebarActivity = {
  subagents: Array.from({ length: 64 }, (_, index) => ({
    id: `worker-${index}`,
    title: `Worker ${index} inspecting an application surface`,
    status: index % 4 === 0 ? "running" : "done",
    input: 10_000 + index,
    output: 2_000 + index,
    order: index,
    summary: `Completed representative audit ${index}`,
  })),
  plan: null,
  usage: { input: 240_000, output: 32_000 },
  context: { used: 80_000, model: "provider/model" },
  openRun: () => ({}) as never,
  clear: () => {},
} as ActivityStore;

const largeMarkdown = Array.from(
  { length: 200 },
  (_, index) =>
    `## Finding ${index}\n\n- retained object check ${index}\n- lifecycle cleanup verified`,
).join("\n\n");

function EmptyWorkflowsPage(props: { active?: Accessor<boolean> } = {}): JSX.Element {
  const { host } = createViewHost({
    interaction: fakeInteraction,
    active: props.active,
    close: () => {},
    dispatch: () => {},
  });
  return WorkflowsHub(host, {
    list: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
    get: async () => {
      throw new Error("not reached");
    },
    getRun: async () => null,
    now: () => Date.now(),
    pollMs: 60_000,
  });
}

const autocompleteItems = Array.from({ length: 30 }, (_, index) => ({
  label: `/command-${String(index).padStart(2, "0")}`,
  detail: `Command ${index}`,
  value: `command.${index}`,
  group: index < 15 ? "Actions" : "Navigate",
}));
const [autocompleteScrollIndex, setAutocompleteScrollIndex] = createSignal(0);

const cases: SoakCase[] = [
  {
    name: "control",
    render: (open) => <text>{open() ? "state a" : "state b"}</text>,
  },
  {
    name: "float-empty",
    portal: true,
    render: (open) => (
      <Show when={open()}>
        <FloatFrame title="Empty frame" footer="close">
          <box />
        </FloatFrame>
      </Show>
    ),
  },
  ...[1, 10, 30].map((rows): SoakCase => ({
    name: `float-${rows}-rows`,
    portal: true,
    render: (open) => (
      <Show when={open()}>
        <FloatFrame title={`${rows} rows`} footer="close">
          <For each={Array.from({ length: rows }, (_, index) => index)}>
            {(index) => <text>{`row ${index}`}</text>}
          </For>
        </FloatFrame>
      </Show>
    ),
  })),
  {
    name: "autocomplete-remount-10-rows",
    render: (open) => (
      <Show when={open()}>
        <AutocompletePopup label="commands" items={autocompleteItems} index={0} term="" />
      </Show>
    ),
  },
  {
    name: "autocomplete-retained-10-rows",
    render: (open) => (
      <SurfaceBoundary active={open} retention="retain-one">
        {(lifecycle) => (
          <AutocompletePopup
            visible={lifecycle.active()}
            label="commands"
            items={autocompleteItems}
            index={0}
            term=""
          />
        )}
      </SurfaceBoundary>
    ),
  },
  {
    name: "autocomplete-retained-scroll-10-rows",
    advance: (cycle) => setAutocompleteScrollIndex(cycle % autocompleteItems.length),
    render: (open) => (
      <SurfaceBoundary active={open} retention="retain-one">
        {(lifecycle) => (
          <AutocompletePopup
            visible={lifecycle.active()}
            label="commands"
            items={autocompleteItems}
            index={autocompleteScrollIndex()}
            term=""
          />
        )}
      </SurfaceBoundary>
    ),
  },
  {
    name: "page-frame-remount-30-rows",
    render: (open) => (
      <Show when={open()}>
        <PageFrame title="Page" interaction={fakeInteraction}>
          <For each={Array.from({ length: 30 }, (_, index) => index)}>
            {(index) => <text>{`page row ${index}`}</text>}
          </For>
        </PageFrame>
      </Show>
    ),
  },
  {
    name: "page-frame-retained-30-rows",
    render: (open) => (
      <SurfaceBoundary active={open} retention="retain-one">
        {() => (
          <SurfaceRegion>
            <PageFrame title="Page" interaction={fakeInteraction}>
              <For each={Array.from({ length: 30 }, (_, index) => index)}>
                {(index) => <text>{`page row ${index}`}</text>}
              </For>
            </PageFrame>
          </SurfaceRegion>
        )}
      </SurfaceBoundary>
    ),
  },
  {
    name: "activity-detail-200-markdown-sections",
    portal: true,
    render: (open) => (
      <SurfaceBoundary active={open} retention="retain-one">
        {() => (
          <ActivityDetail
            interaction={fakeInteraction}
            detail={() => ({
              title: "Large result",
              eyebrow: "Completed sub-agent",
              content: largeMarkdown,
            })}
            onClose={() => {}}
          />
        )}
      </SurfaceBoundary>
    ),
  },
  {
    name: "worktree-exit-prompt",
    portal: true,
    render: (open) => (
      <SurfaceBoundary active={open} retention="retain-one">
        {() => (
          <WorktreeExitPrompt
            interaction={fakeInteraction}
            name="audit-worktree"
            branch="audit/overlay-lifecycle"
            onRemove={() => {}}
            onKeep={() => {}}
            onCancel={() => {}}
          />
        )}
      </SurfaceBoundary>
    ),
  },
  {
    name: "profile-picker-30-agents",
    portal: true,
    render: (open) => (
      <Show when={open()}>
        <ProfilePicker
          interaction={fakeInteraction}
          list={() => profiles}
          active={() => "agent-0"}
          defaults={() => ({ global: "agent-1" })}
          onConfirm={() => {}}
          onSetDefault={() => true}
          onClearDefault={() => true}
        />
      </Show>
    ),
  },
  {
    name: "profile-picker-retained-30-agents",
    portal: true,
    render: (open) => (
      <SurfaceBoundary active={open} retention="retain-one">
        {(lifecycle) => (
          <ProfilePicker
            interaction={fakeInteraction}
            enabled={lifecycle.active}
            list={() => profiles}
            active={() => "agent-0"}
            defaults={() => ({ global: "agent-1" })}
            onConfirm={() => {}}
            onSetDefault={() => true}
            onClearDefault={() => true}
          />
        )}
      </SurfaceBoundary>
    ),
  },
  {
    name: "safety-preset-picker-retained",
    portal: true,
    render: (open) => (
      <SurfaceBoundary active={open} retention="retain-one">
        {(lifecycle) => (
          <SafetyPresetPicker
            interaction={fakeInteraction}
            settings={safetySettings}
            guard={safetyGuard}
            scope={() => "global"}
            runActive={() => false}
            active={lifecycle.active}
            notify={() => {}}
            onClose={() => {}}
            onApplied={() => {}}
          />
        )}
      </SurfaceBoundary>
    ),
  },
  {
    name: "catalog-picker-100-rows",
    portal: true,
    render: (open) => (
      <Show when={open()}>
        <CatalogPicker
          keymap={fakeInteraction.keymap}
          title="Catalog benchmark"
          rows={() => catalogRows}
          onPick={() => {}}
          onClose={() => {}}
        />
      </Show>
    ),
  },
  {
    name: "catalog-picker-retained-100-rows",
    portal: true,
    render: (open) => (
      <SurfaceBoundary active={open} retention="retain-one">
        {(lifecycle) => (
          <CatalogPicker
            keymap={fakeInteraction.keymap}
            active={lifecycle.active}
            title="Catalog benchmark"
            rows={() => catalogRows}
            onPick={() => {}}
            onClose={() => {}}
          />
        )}
      </SurfaceBoundary>
    ),
  },
  {
    name: "elicit-guard-confirm",
    render: (open) => (
      <Show when={open()}>
        <ElicitBlock interaction={fakeInteraction} request={guardRequest} onResolve={() => {}} />
      </Show>
    ),
  },
  {
    name: "sidebar-drawer-64-agents",
    render: (open) => (
      <Show when={open()}>
        <box width={36} height="100%">
          <Sidebar
            activity={sidebarActivity}
            focused={() => false}
            contextWindow={() => 128_000}
            width={() => 36}
          />
        </box>
      </Show>
    ),
  },
  {
    name: "sidebar-drawer-retained-64-agents",
    render: (open) => (
      <SurfaceBoundary active={open} retention="retain-one">
        {() => (
          <box width={36} height="100%">
            <Sidebar
              activity={sidebarActivity}
              focused={() => false}
              contextWindow={() => 128_000}
              width={() => 36}
            />
          </box>
        )}
      </SurfaceBoundary>
    ),
  },
  {
    name: "hint-toast",
    render: (open) => (
      <Show when={open()}>
        <HintToast hint={() => ({ text: "Representative notification", tone: "info" })} />
      </Show>
    ),
  },
  {
    name: "splash",
    render: (open) => (
      <Show when={open()}>
        <Splash agent={() => "coder"} model={() => "provider/model"} width={() => width} />
      </Show>
    ),
  },
  {
    name: "workflows-page-empty",
    render: (open) => (
      <Show when={open()}>
        <EmptyWorkflowsPage />
      </Show>
    ),
  },
  {
    name: "workflows-page-retained-empty",
    render: (open) => (
      <SurfaceBoundary active={open} retention="retain-one">
        {(lifecycle) => (
          <SurfaceRegion>
            <EmptyWorkflowsPage active={lifecycle.active} />
          </SurfaceRegion>
        )}
      </SurfaceBoundary>
    ),
  },
];

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function matrixSizes(): { width: number; height: number }[] {
  const raw = process.env.OVERLAY_SOAK_SIZES ?? "120x32,80x24";
  const sizes = raw.split(",").flatMap((entry) => {
    const match = /^(\d+)x(\d+)$/.exec(entry.trim());
    if (!match) return [];
    return [{ width: Number(match[1]), height: Number(match[2]) }];
  });
  if (sizes.length === 0) throw new Error(`invalid OVERLAY_SOAK_SIZES: ${raw}`);
  return sizes;
}

function processRss(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    const match = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${String(pid)}/status`, "utf8"));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

const PRODUCTION_CASES = new Set([
  "autocomplete-retained-10-rows",
  "autocomplete-retained-scroll-10-rows",
  "activity-detail-200-markdown-sections",
  "worktree-exit-prompt",
  "profile-picker-retained-30-agents",
  "safety-preset-picker-retained",
  "catalog-picker-retained-100-rows",
  "elicit-guard-confirm",
  "sidebar-drawer-retained-64-agents",
  "hint-toast",
  "splash",
  "workflows-page-retained-empty",
]);

function countRenderables(root: BaseRenderable): number {
  let count = 1;
  for (const child of root.getChildren()) count += countRenderables(child);
  return count;
}

function linuxMemory(): Pick<MemorySample, "pss" | "privateDirty"> {
  if (process.platform !== "linux") return { pss: null, privateDirty: null };
  const fields = new Map<string, number>();
  for (const line of readFileSync("/proc/self/smaps_rollup", "utf8").split("\n")) {
    const match = /^(Pss|Private_Dirty):\s+(\d+) kB$/.exec(line);
    if (match) fields.set(match[1]!, Number(match[2]!) * 1024);
  }
  return {
    pss: fields.get("Pss") ?? null,
    privateDirty: fields.get("Private_Dirty") ?? null,
  };
}

async function settleRemoval(flush: () => Promise<void>): Promise<void> {
  await flush();
  await new Promise<void>((resolve) => process.nextTick(resolve));
  await new Promise<void>((resolve) => process.nextTick(resolve));
  await flush();
}

async function collect(
  cycle: number,
  root: BaseRenderable,
  lifecyclePasses: () => number,
): Promise<MemorySample> {
  Bun.gc(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  Bun.gc(true);
  const memory = process.memoryUsage();
  const nativeMemory = linuxMemory();
  return {
    cycle,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    ...nativeMemory,
    renderables: countRenderables(root),
    lifecyclePasses: lifecyclePasses(),
    keyLayers: keymapCounters.live,
    keyLayerRegistrations: keymapCounters.registrations,
  };
}

function subtract(after: MemorySample, before: MemorySample): Omit<MemorySample, "cycle"> {
  return {
    rss: after.rss - before.rss,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
    pss: after.pss === null || before.pss === null ? null : after.pss - before.pss,
    privateDirty:
      after.privateDirty === null || before.privateDirty === null
        ? null
        : after.privateDirty - before.privateDirty,
    renderables: after.renderables - before.renderables,
    lifecyclePasses: after.lifecyclePasses - before.lifecyclePasses,
    keyLayers: after.keyLayers - before.keyLayers,
    keyLayerRegistrations: after.keyLayerRegistrations - before.keyLayerRegistrations,
  };
}

async function runCase(subject: SoakCase): Promise<CaseResult> {
  const [open, setOpen] = createSignal(false);
  let sequence = 0;
  const rendered = await testRender(
    () => (
      <box width="100%" height="100%">
        {subject.portal ? (
          <SurfacePortal>{subject.render(open)}</SurfacePortal>
        ) : (
          subject.render(open)
        )}
      </box>
    ),
    { width, height, consoleMode: "disabled" },
  );

  const oneCycle = async (): Promise<void> => {
    setOpen(true);
    subject.advance?.(sequence++);
    await rendered.flush();
    await rendered.waitForVisualIdle();
    if (subject.advance) return;
    setOpen(false);
    await settleRemoval(rendered.flush);
  };

  try {
    for (let index = 0; index < warmupCycles; index += 1) await oneCycle();
    const lifecyclePasses = (): number => rendered.renderer.getLifecyclePasses().size;
    const samples: MemorySample[] = [await collect(0, rendered.renderer.root, lifecyclePasses)];
    for (let completed = 0; completed < cycles; completed += 1) {
      await oneCycle();
      const count = completed + 1;
      if (count % batchSize === 0 || count === cycles) {
        samples.push(await collect(count, rendered.renderer.root, lifecyclePasses));
      }
    }
    const first = samples[0]!;
    const last = samples.at(-1)!;
    const growth = subtract(last, first);
    return {
      name: subject.name,
      runtime: {
        bun: Bun.version,
        opentui: (
          JSON.parse(
            readFileSync(Bun.resolveSync("@opentui/core/package.json", packageRoot), "utf8"),
          ) as { version: string }
        ).version,
        width,
        height,
        nativeRender: !process.env.OTUI_NO_NATIVE_RENDER,
      },
      warmupCycles,
      cycles,
      batchSize,
      samples,
      growth,
      rssMiBPer100: (growth.rss / 1024 / 1024 / cycles) * 100,
      pssMiBPer100: growth.pss === null ? null : (growth.pss / 1024 / 1024 / cycles) * 100,
      privateDirtyMiBPer100:
        growth.privateDirty === null ? null : (growth.privateDirty / 1024 / 1024 / cycles) * 100,
    };
  } finally {
    rendered.renderer.destroy();
  }
}

async function runChild(name: string): Promise<void> {
  const subject = cases.find((candidate) => candidate.name === name);
  if (!subject) throw new Error(`unknown overlay soak case: ${name}`);
  process.stdout.write(JSON.stringify(await runCase(subject)) + "\n");
}

async function runParent(selected: string[]): Promise<void> {
  const names = selected.length > 0 ? selected : cases.map((subject) => subject.name);
  const results: CaseResult[] = [];
  for (const size of matrixSizes()) {
    for (const name of names) {
      if (!cases.some((subject) => subject.name === name)) {
        throw new Error(`unknown overlay soak case: ${name}`);
      }
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          "@opentui/solid/preload",
          import.meta.path,
          `--child=${name}`,
        ],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            OVERLAY_SOAK_WIDTH: String(size.width),
            OVERLAY_SOAK_HEIGHT: String(size.height),
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "inherit",
        },
      );
      const watchdogState: { failure: string | null } = { failure: null };
      const startedAt = Date.now();
      const watchdog = setInterval(() => {
        const rss = processRss(child.pid);
        if (Date.now() - startedAt > watchdogMs) {
          watchdogState.failure = `exceeded ${String(watchdogMs)}ms`;
        } else if (rss !== null && rss > watchdogRssBytes) {
          watchdogState.failure = `exceeded ${(watchdogRssBytes / 1024 / 1024).toFixed(0)} MiB RSS`;
        }
        if (watchdogState.failure !== null) child.kill("SIGKILL");
      }, 100);
      watchdog.unref();
      const output = await new Response(child.stdout).text();
      const exitCode = await child.exited;
      clearInterval(watchdog);
      if (watchdogState.failure !== null)
        throw new Error(`overlay soak child ${name} ${watchdogState.failure}`);
      if (exitCode !== 0) throw new Error(`overlay soak child ${name} exited ${exitCode}`);
      const result = JSON.parse(output.trim()) as CaseResult;
      results.push(result);
      const pss =
        result.pssMiBPer100 === null ? "n/a" : `${result.pssMiBPer100.toFixed(2)} MiB/100`;
      const renderMode = result.runtime.nativeRender ? "native-render" : "no-native-render";
      process.stderr.write(
        `${result.name} ${String(size.width)}x${String(size.height)} [${renderMode}]: ` +
          `RSS ${result.rssMiBPer100.toFixed(2)} MiB/100; PSS ${pss}; ` +
          `renderables Δ${result.growth.renderables}; lifecycle Δ${result.growth.lifecyclePasses}; ` +
          `key layers Δ${result.growth.keyLayers}, registrations ` +
          `+${result.growth.keyLayerRegistrations} post-GC cycles\n`,
      );
      if (PRODUCTION_CASES.has(name)) {
        const retainedGrowth = result.pssMiBPer100 ?? result.rssMiBPer100;
        if (retainedGrowth > maxMiBPer100) {
          throw new Error(
            `${name} grew ${retainedGrowth.toFixed(2)} MiB/100 above the ${maxMiBPer100.toFixed(2)} MiB threshold`,
          );
        }
        if (
          result.growth.renderables !== 0 ||
          result.growth.lifecyclePasses !== 0 ||
          result.growth.keyLayers !== 0
        ) {
          throw new Error(
            `${name} left live owners: renderables ${String(result.growth.renderables)}, ` +
              `lifecycle ${String(result.growth.lifecyclePasses)}, key layers ${String(result.growth.keyLayers)}`,
          );
        }
      }
    }
  }
  process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
}

const childArg = process.argv.find((argument) => argument.startsWith("--child="));
if (childArg) {
  try {
    await runChild(childArg.slice("--child=".length));
  } finally {
    keymapHarness.cleanup();
  }
} else {
  await runParent(process.argv.slice(2).filter((argument) => !argument.startsWith("--")));
}
