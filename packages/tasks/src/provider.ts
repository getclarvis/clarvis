/** Stable normalized stage used by Clarvis prompts, filters, and boards. */
export type TaskStage =
  "backlog" | "ready" | "active" | "blocked" | "review" | "done" | "cancelled" | "other";

/** A task's identity in the currently selected provider. */
export interface TaskRef {
  providerKey: string;
  id: string;
}

/** Project, board, space, or equivalent container. */
export interface TaskContainerRef {
  id: string;
  label: string;
  kind?: "project" | "board" | "space" | "other";
}

/** Provider-native workflow state retained alongside the normalized stage. */
export interface TaskNativeState {
  id: string;
  label: string;
}

/** A human, team, agent, service, or unknown provider actor. */
export interface TaskActor {
  id: string;
  label: string;
  kind: "human" | "team" | "agent" | "service" | "unknown";
}

/** The Clarvis execution lineage currently acting on a task. */
export interface TaskClaim {
  claimant: TaskActor;
  executionId: string;
  claimedAt: string;
}

export type TaskTransitionIntent = "start" | "block" | "submit_review" | "complete" | "reopen";

/** Bounded list/card projection. */
export interface TaskSummary {
  ref: TaskRef;
  container: TaskContainerRef;
  title: string;
  stage: TaskStage;
  nativeState: TaskNativeState;
  priority?: string;
  assignee?: TaskActor;
  claim?: TaskClaim;
  labels: string[];
  updatedAt?: string;
  revision?: string;
  url?: string;
}

/** Complete model/control-plane projection. */
export interface TaskDocument extends TaskSummary {
  description?: string;
  acceptanceCriteria: string[];
  availableIntents: TaskTransitionIntent[];
}

export interface TaskProviderCapabilities {
  protocolVersion: 2;
  /** Stable, opaque identity of the remote installation/tenant. Never a secret. */
  providerInstanceId: string;
  providerKind: string;
  read: {
    containers: true;
    search: true;
    get: true;
    actors: boolean;
  };
  write: {
    create: boolean;
    assign: boolean;
    comment: boolean;
    attachArtifact: boolean;
    intents: TaskTransitionIntent[];
  };
  concurrency: "none" | "revision" | "exclusive_claim";
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

export type TaskContainerPage = CursorPage<TaskContainerRef>;
export type TaskPage = CursorPage<TaskSummary>;
export type TaskActorPage = CursorPage<TaskActor>;

export interface ListTaskContainersInput {
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface SearchTasksInput {
  containerId?: string;
  query?: string;
  stages?: TaskStage[];
  assigneeId?: string;
  labels?: string[];
  claim?: "any" | "free" | "claimed";
  updatedAfter?: string;
  cursor?: string;
  limit?: number;
}

export interface SearchTaskActorsInput {
  containerId?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}

/** Authority and idempotency context built only by Clarvis. */
export interface TaskMutationContext {
  owner: string;
  actor: TaskActor;
  /** Current execution, used for audit. */
  executionId?: string;
  /** Stable execution lineage used by an exclusive claim across continuations. */
  claimExecutionId?: string;
  idempotencyKey: string;
  expectedRevision?: string;
}

export interface CreateTaskInput {
  containerId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: string;
  assigneeId?: string;
  labels?: string[];
  mutation: TaskMutationContext;
}

export interface AssignTaskInput {
  ref: TaskRef;
  assigneeId: string | null;
  mutation: TaskMutationContext;
}

export interface TransitionTaskInput {
  ref: TaskRef;
  intent: TaskTransitionIntent;
  claimant?: TaskActor;
  reason?: string;
  mutation: TaskMutationContext;
}

export interface CommentTaskInput {
  ref: TaskRef;
  body: string;
  mutation: TaskMutationContext;
}

export interface TaskArtifact {
  kind: "pull_request" | "run" | "document" | "url";
  label: string;
  url?: string;
  executionId?: string;
}

export interface AttachTaskArtifactInput {
  ref: TaskRef;
  artifact: TaskArtifact;
  mutation: TaskMutationContext;
}

/** Product-neutral task provider contract. */
export interface TaskProvider {
  readonly kind: string;
  readonly key: string;
  capabilities(signal?: AbortSignal): Promise<TaskProviderCapabilities>;
  listContainers(input: ListTaskContainersInput, signal?: AbortSignal): Promise<TaskContainerPage>;
  search(input: SearchTasksInput, signal?: AbortSignal): Promise<TaskPage>;
  get(ref: TaskRef, signal?: AbortSignal): Promise<TaskDocument>;
  searchActors?(input: SearchTaskActorsInput, signal?: AbortSignal): Promise<TaskActorPage>;
  create?(input: CreateTaskInput, signal?: AbortSignal): Promise<TaskDocument>;
  assign?(input: AssignTaskInput, signal?: AbortSignal): Promise<TaskDocument>;
  transition?(input: TransitionTaskInput, signal?: AbortSignal): Promise<TaskDocument>;
  comment?(input: CommentTaskInput, signal?: AbortSignal): Promise<TaskDocument>;
  attachArtifact?(input: AttachTaskArtifactInput, signal?: AbortSignal): Promise<TaskDocument>;
}

/** Settings-sensitive provider resolution shared by runs and control-plane calls. */
export interface TaskProviderResolution {
  provider: TaskProvider;
  capabilities: TaskProviderCapabilities;
  writes: "disabled" | "enabled";
  defaultContainer?: string;
  server: string;
}

export interface TaskProviderResolver {
  resolve(
    owner: string,
    expectedProviderKey?: string,
    signal?: AbortSignal,
  ): Promise<TaskProviderResolution>;
}
