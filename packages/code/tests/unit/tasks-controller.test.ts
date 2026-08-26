import { expect, test } from "bun:test";
import type {
  TaskDocumentDto,
  TaskProviderCapabilitiesDto,
  TaskProviderStatusDto,
  TasksService,
} from "@clarvis/protocol";
import { createTasksController } from "../../src/features/tasks/controller.ts";

const STATUS: TaskProviderStatusDto = {
  state: "ready",
  provider_key: "provider-key",
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
  concurrency: "exclusive_claim",
};

const DOCUMENT: TaskDocumentDto = {
  ref: { provider_key: "provider-key", id: "CLAR-42" },
  container: { id: "CLAR", label: "Clarvis", kind: "project" },
  title: "Fix authentication",
  stage: "ready",
  native_state: { id: "todo", label: "To do" },
  labels: [],
  acceptance_criteria: [],
  available_intents: ["start"],
};

test("Tasks controller delegates the full UI surface and carries read cancellation metadata", async () => {
  const calls: { operation: string; input?: unknown; signal?: unknown }[] = [];
  const service: TasksService = {
    status: async (options) => {
      calls.push({ operation: "status", signal: options?.signal });
      return STATUS;
    },
    capabilities: async (options) => {
      calls.push({ operation: "capabilities", signal: options?.signal });
      return CAPABILITIES;
    },
    listContainers: async (input, options) => {
      calls.push({ operation: "containers", input, signal: options?.signal });
      return { items: [DOCUMENT.container], next_cursor: "containers-next" };
    },
    search: async (input, options) => {
      calls.push({ operation: "search", input, signal: options?.signal });
      return { items: [DOCUMENT], next_cursor: "tasks-next" };
    },
    get: async (input, options) => {
      calls.push({ operation: "get", input, signal: options?.signal });
      return DOCUMENT;
    },
    searchActors: async (input, options) => {
      calls.push({ operation: "actors", input, signal: options?.signal });
      return { items: [{ id: "ana", label: "Ana", kind: "human" }] };
    },
    create: async (input) => {
      calls.push({ operation: "create", input });
      return DOCUMENT;
    },
    assign: async (input) => {
      calls.push({ operation: "assign", input });
      return DOCUMENT;
    },
    previewTransition: async (input) => {
      calls.push({ operation: "preview", input });
      return {
        confirmation_token: "confirm",
        expires_at: "2026-08-09T12:05:00Z",
        task: DOCUMENT,
      };
    },
    transition: async (input) => {
      calls.push({ operation: "transition", input });
      return DOCUMENT;
    },
    comment: async (input) => {
      calls.push({ operation: "comment", input });
      return DOCUMENT;
    },
    attachArtifact: async () => DOCUMENT,
  };
  let active = false;
  const worked: unknown[] = [];
  const controller = createTasksController({
    service,
    available: () => true,
    runActive: () => active,
    workOnTask: async (ref, profile) => {
      worked.push({ ref, profile });
    },
  });
  const abort = new AbortController();

  expect(controller.available()).toBeTrue();
  expect(await controller.status(abort.signal)).toEqual(STATUS);
  expect(await controller.capabilities(abort.signal)).toEqual(CAPABILITIES);
  expect(await controller.listContainers({ cursor: "opaque" }, abort.signal)).toMatchObject({
    next_cursor: "containers-next",
  });
  expect(await controller.search({ query: "auth" }, abort.signal)).toMatchObject({
    next_cursor: "tasks-next",
  });
  expect(await controller.get(DOCUMENT.ref, abort.signal)).toEqual(DOCUMENT);
  expect(await controller.searchActors({ query: "Ana" }, abort.signal)).toMatchObject({
    items: [{ id: "ana" }],
  });
  await controller.create({
    provider_key: STATUS.provider_key!,
    container_id: "CLAR",
    title: "new",
  });
  await controller.assign({ ref: DOCUMENT.ref, assignee_id: "ana" });
  await controller.previewTransition({ ref: DOCUMENT.ref, intent: "complete" });
  await controller.transition({ ref: DOCUMENT.ref, intent: "block" });
  await controller.comment({ ref: DOCUMENT.ref, body: "note" });
  expect(calls.slice(0, 6).every((call) => call.signal === abort.signal)).toBeTrue();
  expect(
    calls
      .filter((call) => ["create", "assign", "transition", "comment"].includes(call.operation))
      .every(
        (call) =>
          typeof (call.input as { request_id?: unknown } | undefined)?.request_id === "string",
      ),
  ).toBeTrue();

  expect(controller.workBlocked()).toBeFalse();
  await controller.workOnTask(DOCUMENT.ref, "coder");
  active = true;
  expect(controller.workBlocked()).toBeTrue();
  expect(worked).toEqual([{ ref: DOCUMENT.ref, profile: "coder" }]);
});

test("Tasks controller is unavailable only when the host capability says so", () => {
  const controller = createTasksController({
    service: {} as TasksService,
    available: () => false,
    runActive: () => false,
    workOnTask: async () => {},
  });
  expect(controller.available()).toBeFalse();
});

function mutationService(overrides: Partial<TasksService>): TasksService {
  return {
    status: async () => STATUS,
    capabilities: async () => CAPABILITIES,
    listContainers: async () => ({ items: [DOCUMENT.container] }),
    search: async () => ({ items: [DOCUMENT] }),
    get: async () => DOCUMENT,
    searchActors: async () => ({ items: [] }),
    create: async () => DOCUMENT,
    assign: async () => DOCUMENT,
    previewTransition: async () => ({
      confirmation_token: "confirm",
      expires_at: "2026-08-09T12:05:00Z",
      task: DOCUMENT,
    }),
    transition: async () => DOCUMENT,
    comment: async () => DOCUMENT,
    attachArtifact: async () => DOCUMENT,
    ...overrides,
  };
}

function mutationController(service: TasksService) {
  return createTasksController({
    service,
    runActive: () => false,
    workOnTask: async () => {},
  });
}

test("an uncertain comment retry replays the exact request id and revision", async () => {
  const calls: Parameters<TasksService["comment"]>[0][] = [];
  const unknown = Object.assign(new Error("connection dropped"), {
    details: { outcome_unknown: true },
  });
  const controller = mutationController(
    mutationService({
      comment: async (input) => {
        calls.push(input);
        if (calls.length === 1) throw unknown;
        return DOCUMENT;
      },
    }),
  );

  await expect(
    controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "7" }),
  ).rejects.toThrow("connection dropped");
  await controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "8" });

  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]?.expected_revision).toBe("7");
  expect(calls[0]?.request_id).toBeString();
});

test("an uncertain destructive transition retains its confirmation and prepared input", async () => {
  const calls: Parameters<TasksService["transition"]>[0][] = [];
  const unknown = Object.assign(new Error("response lost"), {
    code: "task_outcome_unknown",
  });
  const controller = mutationController(
    mutationService({
      transition: async (input) => {
        calls.push(input);
        if (calls.length === 1) throw unknown;
        return DOCUMENT;
      },
    }),
  );

  await expect(
    controller.transition({
      ref: DOCUMENT.ref,
      intent: "complete",
      expected_revision: "7",
      confirmation_token: "confirm-original",
    }),
  ).rejects.toThrow("response lost");
  await controller.transition({
    ref: DOCUMENT.ref,
    intent: "complete",
    expected_revision: "8",
    confirmation_token: "confirm-replacement",
  });

  expect(calls[1]).toEqual(calls[0]);
  expect(calls[1]?.confirmation_token).toBe("confirm-original");
});

test("a transient failure while replaying an uncertain mutation retains the original request", async () => {
  const calls: Parameters<TasksService["comment"]>[0][] = [];
  const unknown = Object.assign(new Error("response lost"), {
    details: { outcome_unknown: true },
  });
  const unavailable = Object.assign(new Error("provider restarting"), {
    details: { task_code: "task_provider_unavailable" },
  });
  const controller = mutationController(
    mutationService({
      comment: async (input) => {
        calls.push(input);
        if (calls.length === 1) throw unknown;
        if (calls.length === 2) throw unavailable;
        return DOCUMENT;
      },
    }),
  );

  await expect(
    controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "7" }),
  ).rejects.toThrow("response lost");
  await expect(
    controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "8" }),
  ).rejects.toThrow("provider restarting");
  await controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "9" });

  expect(calls).toHaveLength(3);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[2]).toEqual(calls[0]);
});

test("a first unavailable response retains its request id for a safe explicit retry", async () => {
  const calls: Parameters<TasksService["comment"]>[0][] = [];
  const unavailable = Object.assign(new Error("transport closed"), { code: "unavailable" });
  const controller = mutationController(
    mutationService({
      comment: async (input) => {
        calls.push(input);
        if (calls.length === 1) throw unavailable;
        return DOCUMENT;
      },
    }),
  );

  await expect(
    controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "7" }),
  ).rejects.toThrow("transport closed");
  await controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "8" });

  expect(calls[1]).toEqual(calls[0]);
});

test("a local failure cannot discard an earlier unknown request", async () => {
  const calls: Parameters<TasksService["comment"]>[0][] = [];
  const unknown = Object.assign(new Error("response lost"), {
    details: { outcome_unknown: true },
  });
  const writesDisabled = Object.assign(new Error("writes disabled"), {
    details: { task_code: "task_writes_disabled" },
  });
  const controller = mutationController(
    mutationService({
      comment: async (input) => {
        calls.push(input);
        if (calls.length === 1) throw unknown;
        if (calls.length === 2) throw writesDisabled;
        return DOCUMENT;
      },
    }),
  );

  await expect(
    controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "7" }),
  ).rejects.toThrow("response lost");
  await expect(
    controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "8" }),
  ).rejects.toThrow("writes disabled");
  await controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "9" });

  expect(calls[1]).toEqual(calls[0]);
  expect(calls[2]).toEqual(calls[0]);
});

test("concurrent identical actions share one replay attempt", async () => {
  const calls: Parameters<TasksService["comment"]>[0][] = [];
  const unknown = Object.assign(new Error("response lost"), {
    details: { outcome_unknown: true },
  });
  let rejectFirst!: (error: unknown) => void;
  const firstAttempt = new Promise<TaskDocumentDto>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const controller = mutationController(
    mutationService({
      comment: (input) => {
        calls.push(input);
        return calls.length === 1 ? firstAttempt : Promise.resolve(DOCUMENT);
      },
    }),
  );
  const command = { ref: DOCUMENT.ref, body: "same update", expected_revision: "7" } as const;

  const first = controller.comment(command);
  const second = controller.comment(command);
  expect(calls).toHaveLength(1);
  const outcomes = Promise.all([
    first.catch((error: unknown) => error),
    second.catch((error: unknown) => error),
  ]);
  rejectFirst(unknown);
  expect(await outcomes).toEqual([unknown, unknown]);

  await controller.comment({ ...command, expected_revision: "8" });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
});

test("unresolved mutation replay state is never evicted to admit a new intention", async () => {
  const calls: Parameters<TasksService["comment"]>[0][] = [];
  const unknown = Object.assign(new Error("response lost"), {
    code: "task_outcome_unknown",
  });
  const controller = mutationController(
    mutationService({
      comment: async (input) => {
        calls.push(input);
        throw unknown;
      },
    }),
  );

  for (let index = 0; index < 32; index += 1) {
    await expect(
      controller.comment({ ref: DOCUMENT.ref, body: `uncertain-${index}` }),
    ).rejects.toThrow("response lost");
  }
  await expect(controller.comment({ ref: DOCUMENT.ref, body: "one-too-many" })).rejects.toThrow(
    "Too many unresolved task mutations",
  );

  expect(calls).toHaveLength(32);
  await expect(controller.comment({ ref: DOCUMENT.ref, body: "uncertain-0" })).rejects.toThrow(
    "response lost",
  );
  expect(calls[32]?.request_id).toBe(calls[0]?.request_id);
});

test("a definitive mutation failure releases the request id for a new intention", async () => {
  const calls: Parameters<TasksService["comment"]>[0][] = [];
  const controller = mutationController(
    mutationService({
      comment: async (input) => {
        calls.push(input);
        if (calls.length === 1) throw new Error("forbidden");
        return DOCUMENT;
      },
    }),
  );

  await expect(
    controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "7" }),
  ).rejects.toThrow("forbidden");
  await controller.comment({ ref: DOCUMENT.ref, body: "same update", expected_revision: "8" });

  expect(calls[0]?.request_id).not.toBe(calls[1]?.request_id);
  expect(calls[1]?.expected_revision).toBe("8");
});
