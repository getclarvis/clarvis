import type { KernelAbortSignal } from "./transport.ts";

export type TaskStageDto =
  "backlog" | "ready" | "active" | "blocked" | "review" | "done" | "cancelled" | "other";

export type TaskTransitionIntentDto = "start" | "block" | "submit_review" | "complete" | "reopen";

export interface TaskRefDto {
  provider_key: string;
  id: string;
}

export interface TaskContainerRefDto {
  id: string;
  label: string;
  kind?: "project" | "board" | "space" | "other";
}

export interface TaskNativeStateDto {
  id: string;
  label: string;
}

export interface TaskActorDto {
  id: string;
  label: string;
  kind: "human" | "team" | "agent" | "service" | "unknown";
}

export interface TaskClaimDto {
  claimant: TaskActorDto;
  execution_id: string;
  claimed_at: string;
}

export interface TaskSummaryDto {
  ref: TaskRefDto;
  container: TaskContainerRefDto;
  title: string;
  stage: TaskStageDto;
  native_state: TaskNativeStateDto;
  priority?: string;
  assignee?: TaskActorDto;
  claim?: TaskClaimDto;
  labels: string[];
  updated_at?: string;
  revision?: string;
  url?: string;
}

export interface TaskDocumentDto extends TaskSummaryDto {
  description?: string;
  acceptance_criteria: string[];
  available_intents: TaskTransitionIntentDto[];
}

export interface TaskProviderCapabilitiesDto {
  protocol_version: 2;
  provider_instance_id: string;
  provider_kind: string;
  read: { containers: true; search: true; get: true; actors: boolean };
  write: {
    create: boolean;
    assign: boolean;
    comment: boolean;
    attach_artifact: boolean;
    intents: TaskTransitionIntentDto[];
  };
  concurrency: "none" | "revision" | "exclusive_claim";
}

export interface TaskProviderStatusDto {
  state: "not_configured" | "ready" | "unavailable" | "incompatible";
  provider_key?: string;
  provider_kind?: string;
  server?: string;
  writes: "disabled" | "enabled";
  reason?: string;
}

export interface TaskContainerPageDto {
  items: TaskContainerRefDto[];
  next_cursor?: string;
}

export interface TaskPageDto {
  items: TaskSummaryDto[];
  next_cursor?: string;
}

export interface TaskActorPageDto {
  items: TaskActorDto[];
  next_cursor?: string;
}

export interface ListTaskContainersDto {
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface SearchTasksDto {
  container_id?: string;
  query?: string;
  stages?: TaskStageDto[];
  assignee_id?: string;
  labels?: string[];
  claim?: "any" | "free" | "claimed";
  updated_after?: string;
  cursor?: string;
  limit?: number;
}

export interface SearchTaskActorsDto {
  container_id?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface CreateTaskDto {
  request_id: string;
  /** Pins a retry to the provider selection shown when the create intent began. */
  provider_key: string;
  container_id: string;
  title: string;
  description?: string;
  acceptance_criteria?: string[];
  priority?: string;
  assignee_id?: string;
  labels?: string[];
}

export interface AssignTaskDto {
  request_id: string;
  ref: TaskRefDto;
  assignee_id: string | null;
  expected_revision?: string;
}

/** Human control-plane transitions exclude `start`, which belongs to a bound run. */
export interface TransitionTaskDto {
  request_id: string;
  ref: TaskRefDto;
  intent: Exclude<TaskTransitionIntentDto, "start">;
  reason?: string;
  expected_revision?: string;
  /** Required for complete/reopen and minted by previewTransition. */
  confirmation_token?: string;
}

export interface CommentTaskDto {
  request_id: string;
  ref: TaskRefDto;
  body: string;
  expected_revision?: string;
}

export interface TaskArtifactDto {
  kind: "pull_request" | "run" | "document" | "url";
  label: string;
  url?: string;
  execution_id?: string;
}

export interface AttachTaskArtifactDto {
  request_id: string;
  ref: TaskRefDto;
  artifact: TaskArtifactDto;
  expected_revision?: string;
}

export interface PreviewTaskTransitionDto {
  ref: TaskRefDto;
  intent: "complete" | "reopen";
  expected_revision?: string;
}

export interface TaskTransitionPreviewDto {
  confirmation_token: string;
  expires_at: string;
  task: TaskDocumentDto;
}

/** Cancellation is local transport metadata and is never serialized as params. */
export interface TaskCallOptions {
  signal?: KernelAbortSignal;
}

export interface TasksService {
  status(options?: TaskCallOptions): Promise<TaskProviderStatusDto>;
  capabilities(options?: TaskCallOptions): Promise<TaskProviderCapabilitiesDto>;
  listContainers(
    input: ListTaskContainersDto,
    options?: TaskCallOptions,
  ): Promise<TaskContainerPageDto>;
  search(input: SearchTasksDto, options?: TaskCallOptions): Promise<TaskPageDto>;
  get(ref: TaskRefDto, options?: TaskCallOptions): Promise<TaskDocumentDto>;
  searchActors(input: SearchTaskActorsDto, options?: TaskCallOptions): Promise<TaskActorPageDto>;
  create(input: CreateTaskDto, options?: TaskCallOptions): Promise<TaskDocumentDto>;
  assign(input: AssignTaskDto, options?: TaskCallOptions): Promise<TaskDocumentDto>;
  previewTransition(
    input: PreviewTaskTransitionDto,
    options?: TaskCallOptions,
  ): Promise<TaskTransitionPreviewDto>;
  transition(input: TransitionTaskDto, options?: TaskCallOptions): Promise<TaskDocumentDto>;
  comment(input: CommentTaskDto, options?: TaskCallOptions): Promise<TaskDocumentDto>;
  attachArtifact(input: AttachTaskArtifactDto, options?: TaskCallOptions): Promise<TaskDocumentDto>;
}

/** Per-run binding; workspace/repository identity is deliberately absent. */
export interface ActiveTaskRequestDto {
  id: string;
  provider_key?: string;
  mode?: "inspect" | "work";
}

/** Validated task identity projected from a run's capability state. */
export interface ActiveTaskBindingDto {
  id: string;
  provider_key: string;
  mode: "inspect" | "work";
}
