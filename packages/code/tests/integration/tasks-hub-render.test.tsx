import { expect, test } from "bun:test";
import type {
  TaskContainerRefDto,
  TaskDocumentDto,
  TaskProviderCapabilitiesDto,
  TaskProviderStatusDto,
  TasksService,
} from "@clarvis/protocol";
import { createTasksController } from "../../src/features/tasks/controller.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { TasksHub } from "../../src/views/config/TasksHub.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { captureUntil } from "../helpers/render-support.ts";
import { openRender } from "../helpers/tracked-render.ts";

const READY: TaskProviderStatusDto = {
  state: "ready",
  provider_key: "tasks:mcp:v1:sha256:abc",
  provider_kind: "jira",
  server: "jira-work:tasks",
  writes: "enabled",
};

const CAPABILITIES: TaskProviderCapabilitiesDto = {
  protocol_version: 2,
  provider_instance_id: "jira-work",
  provider_kind: "jira",
  read: { containers: true, search: true, get: true, actors: true },
  write: {
    create: true,
    assign: true,
    comment: true,
    attach_artifact: true,
    intents: ["start", "block", "submit_review", "complete", "reopen"],
  },
  concurrency: "none",
};

function document(over: Partial<TaskDocumentDto> = {}): TaskDocumentDto {
  return {
    ref: { provider_key: READY.provider_key!, id: "CLAR-42" },
    container: { id: "CLAR", label: "Clarvis", kind: "project" },
    title: "Fix authentication",
    stage: "active",
    native_state: { id: "in-progress", label: "In Progress" },
    priority: "high",
    assignee: { id: "ana", label: "Ana", kind: "human" },
    labels: ["security"],
    revision: "7",
    url: "https://jira.example/browse/CLAR-42",
    description: "Invalid login must not create a session.",
    acceptance_criteria: ["regression tests pass"],
    available_intents: ["start", "block", "submit_review", "complete"],
    ...over,
  };
}

function mount(
  options: {
    status?: TaskProviderStatusDto;
    capabilities?: TaskProviderCapabilitiesDto;
    task?: TaskDocumentDto;
    searchError?: Error;
    runActive?: boolean;
    available?: boolean;
    rows?: TaskDocumentDto[];
    containers?: TaskContainerRefDto[];
    defaultContainer?: string | null;
    commentError?: unknown;
    commentTask?: TasksService["comment"];
    getTask?: TasksService["get"];
    searchTasks?: TasksService["search"];
    workBlockedReason?: () => string | null;
  } = {},
) {
  let current = structuredClone(options.task ?? document());
  const calls: { operation: string; input?: unknown }[] = [];
  const errors: string[] = [];
  const worked: unknown[] = [];
  const service: TasksService = {
    status: async () => options.status ?? READY,
    capabilities: async () => options.capabilities ?? CAPABILITIES,
    listContainers: async () => ({ items: options.containers ?? [current.container] }),
    search: async (input, callOptions) => {
      calls.push({ operation: "search", input });
      if (options.searchError) throw options.searchError;
      if (options.searchTasks) return options.searchTasks(input, callOptions);
      return { items: options.rows ?? [current] };
    },
    get: async (input, callOptions) => {
      calls.push({ operation: "get", input });
      if (options.getTask) return options.getTask(input, callOptions);
      const match = options.rows?.find(
        (candidate) =>
          candidate.ref.provider_key === input.provider_key && candidate.ref.id === input.id,
      );
      return structuredClone(match ?? current);
    },
    searchActors: async () => ({ items: [{ id: "ana", label: "Ana", kind: "human" }] }),
    create: async (input) => {
      calls.push({ operation: "create", input });
      return structuredClone(current);
    },
    assign: async (input) => {
      calls.push({ operation: "assign", input });
      return structuredClone(current);
    },
    previewTransition: async (input) => {
      calls.push({ operation: "preview", input });
      return {
        confirmation_token: "confirm-complete",
        expires_at: "2026-08-09T12:05:00Z",
        task: structuredClone(current),
      };
    },
    transition: async (input) => {
      calls.push({ operation: "transition", input });
      current = {
        ...current,
        stage: input.intent === "complete" ? "done" : current.stage,
        native_state:
          input.intent === "complete" ? { id: "done", label: "Done" } : current.native_state,
      };
      return structuredClone(current);
    },
    comment: async (input) => {
      calls.push({ operation: "comment", input });
      if (options.commentTask) return options.commentTask(input);
      if (options.commentError) throw options.commentError;
      return structuredClone(current);
    },
    attachArtifact: async (input) => {
      calls.push({ operation: "artifact", input });
      return structuredClone(current);
    },
  };
  const controller = createTasksController({
    service,
    available: () => options.available ?? true,
    runActive: () => options.runActive === true,
    workOnTask: async (ref, profile) => {
      worked.push({ ref, profile });
    },
  });
  const { keymap, press } = createFakeKeymap();
  const interaction = { keymap } as unknown as Interaction;
  let closed = 0;
  const { host, controls } = createViewHost({
    interaction,
    close: () => {
      closed += 1;
    },
    dispatch: () => {},
  });
  const deps = {
    controller,
    profiles: () => [
      { name: "coder", model: "openai/gpt", grants: ["tasks.read", "tasks.progress"] },
    ],
    defaultContainer: () =>
      options.defaultContainer === null ? undefined : (options.defaultContainer ?? "CLAR"),
    ...(options.workBlockedReason === undefined
      ? {}
      : { workBlockedReason: options.workBlockedReason }),
    onError: (message: string) => errors.push(message),
  };
  return { host, controls, interaction, press, calls, errors, worked, closed: () => closed, deps };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBeTrue();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function render(mounted: ReturnType<typeof mount>, width = 140) {
  const output = await openRender((() => TasksHub(mounted.host, mounted.deps)) as never, {
    width,
    height: 32,
  });
  (mounted.interaction as unknown as { renderer: typeof output.renderer }).renderer =
    output.renderer;
  await output.renderOnce();
  return output;
}

test("Tasks hub renders the normalized board, native state, detail and list modes", async () => {
  const mounted = mount();
  const output = await render(mounted);
  let frame = await captureUntil(output, "CLAR-42");
  expect(frame).toContain("Backlog");
  expect(frame).toContain("Review");
  expect(frame).toContain("claim not enforced");

  mounted.press("return");
  frame = await captureUntil(output, "Acceptance criteria");
  expect(frame).toContain("In Progress");
  expect(frame).toContain("Invalid login must not create a session.");
  expect(frame).toContain("regression tests pass");
  expect(frame).not.toContain("unassigned");

  mounted.press("escape");
  mounted.press("b");
  expect(await captureUntil(output, "list · CLAR")).toContain("CLAR-42");
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("Tasks hub distinguishes not-configured and provider faults from an empty board", async () => {
  const absent = mount({
    status: {
      state: "not_configured",
      writes: "disabled",
      reason: "No Tasks provider is configured.",
    },
  });
  const absentOutput = await render(absent, 80);
  const absentFrame = await captureUntil(absentOutput, "Tasks provider is not configured");
  expect(absentFrame).not.toContain("no tasks match");
  absentOutput.renderer.destroy();
  absent.controls.dispose();

  const failed = mount({ searchError: new Error("provider connection failed") });
  const failedOutput = await render(failed, 80);
  const failedFrame = await captureUntil(failedOutput, "provider connection failed");
  expect(failedFrame).not.toContain("no tasks match");
  failedOutput.renderer.destroy();
  failed.controls.dispose();
});

test("writes-disabled hides every mutation while Work on task keeps the provider ref only", async () => {
  const mounted = mount({ status: { ...READY, writes: "disabled" } });
  const output = await render(mounted, 100);
  await captureUntil(output, "CLAR-42");
  for (const key of ["c", "a", "t", "m"]) mounted.press(key);
  await output.renderOnce();
  expect(
    mounted.calls.some((call) =>
      ["create", "assign", "preview", "transition", "comment"].includes(call.operation),
    ),
  ).toBeFalse();

  mounted.press("w");
  await captureUntil(output, "Choose agent");
  mounted.press("return");
  await waitFor(() => mounted.worked.length === 1);
  expect(mounted.worked).toEqual([
    {
      ref: { provider_key: READY.provider_key, id: "CLAR-42" },
      profile: "coder",
    },
  ]);
  expect(mounted.closed()).toBe(1);
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("human completion uses legal intents and a revision-bound confirmation preview", async () => {
  const mounted = mount({
    task: document({ available_intents: ["start", "complete"] }),
    capabilities: {
      ...CAPABILITIES,
      concurrency: "revision",
      write: { ...CAPABILITIES.write, intents: ["start", "complete"] },
    },
  });
  const output = await render(mounted);
  await captureUntil(output, "CLAR-42");
  mounted.press("return");
  await captureUntil(output, "Acceptance criteria");
  mounted.press("t");
  const intents = await captureUntil(output, "complete");
  expect(intents).not.toContain("start\n");
  mounted.press("return");
  await waitFor(() => mounted.host.pendingConfirm() !== null);
  expect(mounted.host.pendingConfirm()?.message).toBe("Complete CLAR-42?");
  mounted.press("y");
  await waitFor(() => mounted.calls.some((call) => call.operation === "transition"));
  const transition = mounted.calls.find((call) => call.operation === "transition")?.input;
  expect(transition).toMatchObject({
    ref: { provider_key: READY.provider_key, id: "CLAR-42" },
    intent: "complete",
    expected_revision: "7",
    confirmation_token: "confirm-complete",
  });
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("Work on task stays blocked while another run is active", async () => {
  const mounted = mount({ runActive: true });
  const output = await render(mounted);
  await captureUntil(output, "CLAR-42");
  mounted.press("w");
  await waitFor(() => mounted.errors.length === 1);
  expect(mounted.errors[0]).toContain("finish the active run");
  expect(mounted.worked).toEqual([]);
  expect(mounted.closed()).toBe(0);
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("Work on task rechecks the memory fuse after the agent picker opens", async () => {
  let blockedReason: string | null = null;
  const mounted = mount({ workBlockedReason: () => blockedReason });
  const output = await render(mounted);
  await captureUntil(output, "CLAR-42");

  mounted.press("w");
  await captureUntil(output, "Choose agent");
  blockedReason = "Restoring the interface…";
  mounted.press("return");
  await waitFor(() => mounted.errors.length === 1);

  expect(mounted.errors).toEqual([blockedReason]);
  expect(mounted.worked).toEqual([]);
  expect(mounted.closed()).toBe(0);
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("root actions create, assign and comment with revision-bound requests", async () => {
  const mounted = mount();
  const output = await render(mounted);
  await captureUntil(output, "CLAR-42");

  mounted.press("c");
  await captureUntil(output, "task title");
  await output.mockInput.typeText("New provider-neutral task");
  mounted.press("return");
  await waitFor(() => mounted.calls.some((entry) => entry.operation === "create"));

  mounted.press("a");
  await captureUntil(output, "assignee id");
  await output.mockInput.typeText("-backup");
  mounted.press("return");
  await waitFor(() => mounted.calls.some((entry) => entry.operation === "assign"));

  mounted.press("m");
  await captureUntil(output, "task comment");
  await output.mockInput.typeText("Human update");
  mounted.press("ctrl+s");
  await waitFor(() => mounted.calls.some((entry) => entry.operation === "comment"));

  expect(mounted.calls.find((entry) => entry.operation === "create")?.input).toMatchObject({
    provider_key: READY.provider_key,
    container_id: "CLAR",
    title: "New provider-neutral task",
  });
  expect(mounted.calls.find((entry) => entry.operation === "assign")?.input).toMatchObject({
    ref: { provider_key: READY.provider_key, id: "CLAR-42" },
    expected_revision: "7",
  });
  expect(mounted.calls.find((entry) => entry.operation === "comment")?.input).toMatchObject({
    body: "Human update",
    expected_revision: "7",
  });
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("root mutations and Work on task follow the highlighted row after leaving detail", async () => {
  const first = document({
    ref: { provider_key: READY.provider_key!, id: "CLAR-41" },
    title: "First task",
  });
  const second = document({
    ref: { provider_key: READY.provider_key!, id: "CLAR-42" },
    title: "Second task",
  });
  const mounted = mount({ task: first, rows: [first, second] });
  const output = await render(mounted);
  await captureUntil(output, "First task");

  mounted.press("return");
  await captureUntil(output, "Acceptance criteria");
  mounted.press("escape");
  mounted.press("down");
  mounted.press("m");
  await captureUntil(output, "task comment");
  await output.mockInput.typeText("selected row update");
  mounted.press("ctrl+s");
  await waitFor(() => mounted.calls.some((entry) => entry.operation === "comment"));
  expect(mounted.calls.find((entry) => entry.operation === "comment")?.input).toMatchObject({
    ref: second.ref,
  });

  mounted.press("w");
  await captureUntil(output, "Choose agent");
  mounted.press("return");
  await waitFor(() => mounted.worked.length === 1);
  expect(mounted.worked).toEqual([{ ref: second.ref, profile: "coder" }]);
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("superseded task detail responses cannot replace the current detail", async () => {
  const first = document({
    ref: { provider_key: READY.provider_key!, id: "CLAR-41" },
    title: "Slow first task",
  });
  const second = document({
    ref: { provider_key: READY.provider_key!, id: "CLAR-42" },
    title: "Current second task",
  });
  const firstResponse = deferred<TaskDocumentDto>();
  const secondResponse = deferred<TaskDocumentDto>();
  const mounted = mount({
    task: first,
    rows: [first, second],
    getTask: async (ref) =>
      ref.id === first.ref.id ? firstResponse.promise : secondResponse.promise,
  });
  const output = await render(mounted);
  await captureUntil(output, "CLAR-41");

  mounted.press("return");
  await waitFor(() => mounted.calls.filter((entry) => entry.operation === "get").length === 1);
  mounted.press("escape");
  mounted.press("down");
  mounted.press("return");
  await waitFor(() => mounted.calls.filter((entry) => entry.operation === "get").length === 2);
  secondResponse.resolve(second);
  expect(await captureUntil(output, "Current second task")).not.toContain("Slow first task");

  firstResponse.resolve(first);
  await Promise.resolve();
  await Promise.resolve();
  await output.renderOnce();
  const frame = output.captureCharFrame();
  expect(frame).toContain("Current second task");
  expect(frame).not.toContain("Slow first task");
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("superseded intent lookups cannot transition a previously selected task", async () => {
  const first = document({
    ref: { provider_key: READY.provider_key!, id: "CLAR-41" },
    title: "Slow first task",
  });
  const second = document({
    ref: { provider_key: READY.provider_key!, id: "CLAR-42" },
    title: "Current second task",
  });
  const firstResponse = deferred<TaskDocumentDto>();
  const secondResponse = deferred<TaskDocumentDto>();
  const mounted = mount({
    task: first,
    rows: [first, second],
    getTask: async (ref) =>
      ref.id === first.ref.id ? firstResponse.promise : secondResponse.promise,
  });
  const output = await render(mounted);
  await captureUntil(output, "CLAR-41");

  mounted.press("t");
  await waitFor(() => mounted.calls.filter((entry) => entry.operation === "get").length === 1);
  mounted.press("down");
  mounted.press("t");
  await waitFor(() => mounted.calls.filter((entry) => entry.operation === "get").length === 2);
  secondResponse.resolve(second);
  await captureUntil(output, "Transition");

  firstResponse.resolve(first);
  await Promise.resolve();
  await Promise.resolve();
  mounted.press("return");
  await captureUntil(output, "blocking reason");
  await output.mockInput.typeText("still second");
  mounted.press("return");
  await waitFor(() => mounted.calls.some((entry) => entry.operation === "transition"));
  expect(mounted.calls.find((entry) => entry.operation === "transition")?.input).toMatchObject({
    ref: second.ref,
    reason: "still second",
  });
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("a stale intent lookup failure stays silent after the selection changes", async () => {
  const first = document({
    ref: { provider_key: READY.provider_key!, id: "CLAR-41" },
    title: "Slow first task",
  });
  const second = document({
    ref: { provider_key: READY.provider_key!, id: "CLAR-42" },
    title: "Current second task",
  });
  const firstResponse = deferred<TaskDocumentDto>();
  const mounted = mount({
    task: first,
    rows: [first, second],
    getTask: async () => firstResponse.promise,
  });
  const output = await render(mounted);
  await captureUntil(output, "CLAR-41");

  mounted.press("t");
  await waitFor(() => mounted.calls.filter((entry) => entry.operation === "get").length === 1);
  mounted.press("down");
  firstResponse.reject(new Error("stale provider failure"));
  await Promise.resolve();
  await Promise.resolve();
  await output.renderOnce();

  expect(output.captureCharFrame()).toContain("CLAR-42");
  expect(mounted.errors).toEqual([]);
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("superseded board reloads cannot overwrite the latest provider page", async () => {
  const stale = document({
    ref: { provider_key: READY.provider_key!, id: "CLAR-41" },
    title: "Stale search result",
  });
  const current = document({
    ref: { provider_key: READY.provider_key!, id: "CLAR-42" },
    title: "Current search result",
  });
  const firstSearch = deferred<{ items: TaskDocumentDto[] }>();
  let searches = 0;
  const mounted = mount({
    task: current,
    searchTasks: async () => {
      searches += 1;
      return searches === 1 ? firstSearch.promise : { items: [current] };
    },
  });
  const output = await render(mounted);
  await waitFor(() => searches === 1);

  mounted.press("r");
  expect(await captureUntil(output, "CLAR-42")).not.toContain("CLAR-41");
  firstSearch.resolve({ items: [stale] });
  await Promise.resolve();
  await Promise.resolve();
  await output.renderOnce();
  const frame = output.captureCharFrame();
  expect(frame).toContain("CLAR-42");
  expect(frame).not.toContain("CLAR-41");
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("filters, containers, extra stages and blocking stay explicit", async () => {
  const mounted = mount({
    containers: [
      { id: "CLAR", label: "Clarvis", kind: "project" },
      { id: "OPS", label: "Operations", kind: "board" },
    ],
  });
  const output = await render(mounted, 100);
  await captureUntil(output, "CLAR-42");

  mounted.press("x");
  expect(await captureUntil(output, "Cancelled")).toContain("Other");

  mounted.press("o");
  await captureUntil(output, "Operations");
  mounted.press("down");
  mounted.press("return");
  await waitFor(() =>
    mounted.calls.some(
      (entry) =>
        entry.operation === "search" &&
        (entry.input as { container_id?: string }).container_id === "OPS",
    ),
  );

  mounted.press("/");
  await captureUntil(output, "task search");
  await output.mockInput.typeText("authentication");
  mounted.press("return");
  await waitFor(() =>
    mounted.calls.some(
      (entry) =>
        entry.operation === "search" &&
        (entry.input as { query?: string }).query === "authentication",
    ),
  );

  mounted.press("t");
  await captureUntil(output, "Transition");
  mounted.press("return");
  await captureUntil(output, "blocking reason");
  await output.mockInput.typeText("waiting for access");
  mounted.press("return");
  await waitFor(() => mounted.calls.some((entry) => entry.operation === "transition"));
  expect(mounted.calls.find((entry) => entry.operation === "transition")?.input).toMatchObject({
    intent: "block",
    reason: "waiting for access",
    expected_revision: "7",
  });
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("outcome-unknown failures replace the snapshot and stay distinct from empty", async () => {
  const reread = document({
    title: "Re-read after uncertain write",
    stage: "review",
    native_state: { id: "review", label: "In review" },
    revision: "8",
  });
  const failure = Object.assign(new Error("connection dropped"), {
    details: { outcome_unknown: true, current_task: reread },
  });
  let attempts = 0;
  const mounted = mount({
    commentTask: async () => {
      attempts += 1;
      if (attempts === 1) throw failure;
      return reread;
    },
  });
  const output = await render(mounted, 100);
  await captureUntil(output, "CLAR-42");
  mounted.press("m");
  await captureUntil(output, "task comment");
  await output.mockInput.typeText("once");
  mounted.press("ctrl+s");
  const frame = await captureUntil(output, "outcome unknown");
  expect(frame).toContain("uncertain write");
  expect(frame).not.toContain("no tasks match");
  expect(mounted.errors).toContain(
    "outcome unknown — the task was re-read; inspect it before trying again",
  );

  mounted.press("m");
  await captureUntil(output, "task comment");
  await output.mockInput.typeText("once");
  mounted.press("ctrl+s");
  await waitFor(() => mounted.calls.filter((call) => call.operation === "comment").length === 2);
  const comments = mounted.calls.filter((call) => call.operation === "comment");
  expect(comments[1]?.input).toEqual(comments[0]?.input);
  expect((comments[1]?.input as { expected_revision?: string }).expected_revision).toBe("7");
  output.renderer.destroy();
  mounted.controls.dispose();
});

test("host-unavailable, provider-unavailable and no-container creation remain explicit", async () => {
  const unavailableHost = mount({ available: false });
  const hostOutput = await render(unavailableHost, 80);
  expect(await captureUntil(hostOutput, "Tasks provider is not configured")).not.toContain(
    "no tasks match",
  );
  hostOutput.renderer.destroy();
  unavailableHost.controls.dispose();

  const unavailableProvider = mount({
    status: {
      state: "unavailable",
      writes: "enabled",
      reason: "selected plugin is disabled",
    },
  });
  const providerOutput = await render(unavailableProvider, 80);
  expect(await captureUntil(providerOutput, "selected plugin is disabled")).not.toContain(
    "no tasks match",
  );
  providerOutput.renderer.destroy();
  unavailableProvider.controls.dispose();

  const noContainer = mount({ containers: [], rows: [], defaultContainer: null });
  const createOutput = await render(noContainer, 80);
  await captureUntil(createOutput, "no tasks match");
  noContainer.press("c");
  await waitFor(() => noContainer.errors.length === 1);
  expect(noContainer.errors).toEqual(["choose a container before creating a task"]);
  createOutput.renderer.destroy();
  noContainer.controls.dispose();
});
