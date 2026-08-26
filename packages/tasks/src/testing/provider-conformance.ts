/**
 * The conformance harness a task-provider implementation is checked against.
 *
 * @remarks Published as `@clarvis/tasks/testing` for a consumer outside this
 * repository: the point of a provider-neutral task domain is that somebody else
 * writes the Jira or Trello or in-house provider, and this is how they find out
 * whether it satisfies the contract before Clarvis ever loads it. That no
 * package here imports it is therefore the expected state, not an unused export
 * — the four suites that do use it are this package's own, exercising the
 * harness against its reference providers.
 */

import {
  assignTaskInputSchema,
  attachTaskArtifactInputSchema,
  commentTaskInputSchema,
  createTaskInputSchema,
  taskActorPageSchema,
  taskContainerPageSchema,
  taskDocumentSchema,
  taskPageSchema,
  taskProviderCapabilitiesSchema,
  transitionTaskInputSchema,
} from "../schemas.ts";
import { TaskProviderError } from "../provider-errors.ts";
import type {
  AssignTaskInput,
  AttachTaskArtifactInput,
  CommentTaskInput,
  CreateTaskInput,
  TaskDocument,
  TaskMutationContext,
  TaskProvider,
  TaskRef,
  TransitionTaskInput,
} from "../provider.ts";

export interface TaskProviderConformanceMutationCase<T extends object> {
  /** Valid disposable mutation input. */
  input: T;
  /** A second valid input that differs semantically from `input`. */
  changedInput: T;
}

export interface TaskProviderConformanceMutations {
  create?: TaskProviderConformanceMutationCase<Omit<CreateTaskInput, "mutation">>;
  assign?: TaskProviderConformanceMutationCase<Omit<AssignTaskInput, "mutation">>;
  transitions?: Array<TaskProviderConformanceMutationCase<Omit<TransitionTaskInput, "mutation">>>;
  comment?: TaskProviderConformanceMutationCase<Omit<CommentTaskInput, "mutation">>;
  attachArtifact?: TaskProviderConformanceMutationCase<Omit<AttachTaskArtifactInput, "mutation">>;
}

export interface TaskProviderConformanceFixture {
  provider: TaskProvider;
  readableRef: TaskRef;
  containerId?: string;
  actorQuery?: string;
  mutations?: TaskProviderConformanceMutations;
  mutationContext(operation: string): TaskMutationContext;
}

export interface TaskProviderConformanceReport {
  checks: string[];
  capabilities: Awaited<ReturnType<TaskProvider["capabilities"]>>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Task provider conformance: ${message}`);
}

function sameLogicalResult(first: TaskDocument, second: TaskDocument): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

async function conformantMutation<T extends object>(
  name: string,
  mutationCase: TaskProviderConformanceMutationCase<T>,
  run: (input: T, mutation: TaskMutationContext) => Promise<TaskDocument>,
  context: TaskMutationContext,
): Promise<void> {
  assert(context.idempotencyKey.trim().length > 0, `${name} fixture has no idempotency key`);
  assert(
    JSON.stringify(mutationCase.input) !== JSON.stringify(mutationCase.changedInput),
    `${name} changed-input fixture is identical to its primary input`,
  );
  const first = taskDocumentSchema.parse(await run(mutationCase.input, context));
  const second = taskDocumentSchema.parse(
    await run(mutationCase.input, { ...context, actor: { ...context.actor } }),
  );
  assert(
    sameLogicalResult(first, second),
    `${name} did not return the same logical result on retry`,
  );
  let rejected = false;
  try {
    await run(mutationCase.changedInput, { ...context, actor: { ...context.actor } });
  } catch (error) {
    rejected = error instanceof TaskProviderError && error.code === "task_invalid_input";
  }
  assert(rejected, `${name} accepted a reused idempotency key with different input`);
}

/**
 * Exercise the canonical provider contract without a kernel, transport, or TUI.
 *
 * The fixture must point at disposable provider data: every advertised write is
 * executed twice with one idempotency key to verify logical deduplication.
 */
export async function assertTaskProviderConformance(
  fixture: TaskProviderConformanceFixture,
): Promise<TaskProviderConformanceReport> {
  const { provider } = fixture;
  const capabilities = taskProviderCapabilitiesSchema.parse(await provider.capabilities());
  const checks = ["capabilities"];

  taskContainerPageSchema.parse(
    await provider.listContainers({
      ...(fixture.containerId ? { query: fixture.containerId } : {}),
    }),
  );
  taskPageSchema.parse(
    await provider.search({ ...(fixture.containerId ? { containerId: fixture.containerId } : {}) }),
  );
  taskDocumentSchema.parse(await provider.get(fixture.readableRef));
  checks.push("read");

  assert(
    capabilities.read.actors === (provider.searchActors !== undefined),
    "read.actors and searchActors presence disagree",
  );
  if (provider.searchActors !== undefined) {
    taskActorPageSchema.parse(
      await provider.searchActors({ ...(fixture.actorQuery ? { query: fixture.actorQuery } : {}) }),
    );
    checks.push("actors");
  }

  const expected = {
    create: capabilities.write.create,
    assign: capabilities.write.assign,
    comment: capabilities.write.comment,
    attachArtifact: capabilities.write.attachArtifact,
    transition: capabilities.write.intents.length > 0,
  } as const;
  for (const [method, advertised] of Object.entries(expected)) {
    assert(
      advertised === (provider[method as keyof typeof expected] !== undefined),
      `${method} capability and method presence disagree`,
    );
  }

  const mutations = fixture.mutations ?? {};
  if (provider.create !== undefined) {
    assert(mutations.create !== undefined, "advertised create has no conformance fixture input");
    await conformantMutation(
      "create",
      mutations.create,
      (input, mutation) => provider.create!(createTaskInputSchema.parse({ ...input, mutation })),
      fixture.mutationContext("create"),
    );
    checks.push("create-idempotency");
  }
  if (provider.assign !== undefined) {
    assert(mutations.assign !== undefined, "advertised assign has no conformance fixture input");
    await conformantMutation(
      "assign",
      mutations.assign,
      (input, mutation) => provider.assign!(assignTaskInputSchema.parse({ ...input, mutation })),
      fixture.mutationContext("assign"),
    );
    checks.push("assign-idempotency");
  }
  if (provider.comment !== undefined) {
    assert(mutations.comment !== undefined, "advertised comment has no conformance fixture input");
    await conformantMutation(
      "comment",
      mutations.comment,
      (input, mutation) => provider.comment!(commentTaskInputSchema.parse({ ...input, mutation })),
      fixture.mutationContext("comment"),
    );
    checks.push("comment-idempotency");
  }
  if (provider.attachArtifact !== undefined) {
    assert(
      mutations.attachArtifact !== undefined,
      "advertised attachArtifact has no conformance fixture input",
    );
    await conformantMutation(
      "attachArtifact",
      mutations.attachArtifact,
      (input, mutation) =>
        provider.attachArtifact!(attachTaskArtifactInputSchema.parse({ ...input, mutation })),
      fixture.mutationContext("attachArtifact"),
    );
    checks.push("artifact-idempotency");
  }
  if (provider.transition !== undefined) {
    const transitions = mutations.transitions ?? [];
    for (const intent of capabilities.write.intents) {
      const matching = transitions.filter((candidate) => candidate.input.intent === intent);
      assert(
        matching.length === 1,
        `advertised transition '${intent}' must have exactly one conformance fixture input`,
      );
      const mutationCase = matching[0]!;
      assert(
        mutationCase.changedInput.intent === intent,
        `transition '${intent}' changed-input fixture uses another intent`,
      );
      await conformantMutation(
        `transition '${intent}'`,
        mutationCase,
        (input, mutation) =>
          provider.transition!(transitionTaskInputSchema.parse({ ...input, mutation })),
        fixture.mutationContext(`transition:${intent}`),
      );
      checks.push(`transition-${intent}-idempotency`);
    }
    const unexpected = transitions.find(
      (candidate) => !capabilities.write.intents.includes(candidate.input.intent),
    );
    assert(unexpected === undefined, "transition fixture intent is not advertised");
  }

  return { checks, capabilities };
}
