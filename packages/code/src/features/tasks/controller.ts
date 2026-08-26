import type {
  AssignTaskDto,
  CommentTaskDto,
  CreateTaskDto,
  ListTaskContainersDto,
  PreviewTaskTransitionDto,
  SearchTaskActorsDto,
  SearchTasksDto,
  TaskDocumentDto,
  TaskProviderCapabilitiesDto,
  TaskProviderStatusDto,
  TaskCallOptions,
  TaskRefDto,
  TasksService,
  TransitionTaskDto,
} from "@clarvis/protocol";

export interface TasksControllerDeps {
  service: TasksService;
  available?: () => boolean;
  runActive: () => boolean;
  workOnTask: (ref: TaskRefDto, profile: string) => Promise<void>;
}

type CreateTaskCommand = Omit<CreateTaskDto, "request_id">;
type AssignTaskCommand = Omit<AssignTaskDto, "request_id">;
type TransitionTaskCommand = Omit<TransitionTaskDto, "request_id">;
type CommentTaskCommand = Omit<CommentTaskDto, "request_id">;
type TaskMutationDto = CreateTaskDto | AssignTaskDto | TransitionTaskDto | CommentTaskDto;

const MAX_UNCERTAIN_MUTATIONS = 32;

function outcomeIsUnknown(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const details = "details" in error ? (error as { details?: unknown }).details : undefined;
  if (
    typeof details === "object" &&
    details !== null &&
    "outcome_unknown" in details &&
    details.outcome_unknown === true
  ) {
    return true;
  }
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "task_outcome_unknown";
}

function taskErrorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = "code" in error ? (error as { code?: unknown }).code : undefined;
  const details = "details" in error ? (error as { details?: unknown }).details : undefined;
  if (typeof details === "object" && details !== null && "task_code" in details) {
    return (details as { task_code?: unknown }).task_code;
  }
  return direct;
}

function retryFailureIsTransient(error: unknown): boolean {
  const code = taskErrorCode(error);
  return (
    code === "task_provider_unavailable" ||
    code === "task_cancelled" ||
    code === "cancelled" ||
    code === "unavailable"
  );
}

function mutationKey(operation: string, fields: readonly unknown[]): string {
  return JSON.stringify([operation, ...fields]);
}

/**
 * Reserves the exact provider input before dispatch. A semantic retry replays
 * its request id, revision and confirmation token; once any attempt may be
 * uncertain, only success releases the entry for a new intention.
 */
function createMutationExecutor(service: TasksService) {
  interface ReplayRecord {
    input: TaskMutationDto;
    uncertain: boolean;
    pending?: Promise<TaskDocumentDto>;
  }

  const replays = new Map<string, ReplayRecord>();

  async function execute<TInput extends TaskMutationDto>(
    key: string,
    prepare: () => TInput,
    invoke: (input: TInput) => Promise<TaskDocumentDto>,
  ): Promise<TaskDocumentDto> {
    let record = replays.get(key);
    if (record?.pending !== undefined) return record.pending;
    if (record === undefined && replays.size >= MAX_UNCERTAIN_MUTATIONS) {
      throw new Error(
        "Too many unresolved task mutations; retry an uncertain action before starting another.",
      );
    }
    const input = (record?.input as TInput | undefined) ?? prepare();
    // Reserve before dispatch so concurrent writes cannot overflow the replay bound.
    if (record === undefined) {
      record = { input, uncertain: false };
      replays.set(key, record);
    }
    const activeRecord = record;
    const operation = (async (): Promise<TaskDocumentDto> => {
      try {
        const result = await invoke(input);
        if (replays.get(key) === activeRecord) replays.delete(key);
        return result;
      } catch (error) {
        if (outcomeIsUnknown(error) || retryFailureIsTransient(error) || activeRecord.uncertain) {
          activeRecord.uncertain = true;
        } else if (replays.get(key) === activeRecord) {
          replays.delete(key);
        }
        throw error;
      }
    })();
    activeRecord.pending = operation;
    const clearPending = (): void => {
      if (replays.get(key) === activeRecord && activeRecord.pending === operation) {
        delete activeRecord.pending;
      }
    };
    void operation.then(clearPending, clearPending);
    return operation;
  }

  return {
    create: (input: CreateTaskCommand): Promise<TaskDocumentDto> =>
      execute(
        mutationKey("create", [
          input.provider_key,
          input.container_id,
          input.title,
          input.description,
          input.acceptance_criteria,
          input.priority,
          input.assignee_id,
          input.labels,
        ]),
        () => ({ ...input, request_id: crypto.randomUUID() }),
        (prepared) => service.create(prepared),
      ),
    assign: (input: AssignTaskCommand): Promise<TaskDocumentDto> =>
      execute(
        mutationKey("assign", [input.ref.provider_key, input.ref.id, input.assignee_id]),
        () => ({ ...input, request_id: crypto.randomUUID() }),
        (prepared) => service.assign(prepared),
      ),
    transition: (input: TransitionTaskCommand): Promise<TaskDocumentDto> =>
      execute(
        mutationKey("transition", [
          input.ref.provider_key,
          input.ref.id,
          input.intent,
          input.reason,
        ]),
        () => ({ ...input, request_id: crypto.randomUUID() }),
        (prepared) => service.transition(prepared),
      ),
    comment: (input: CommentTaskCommand): Promise<TaskDocumentDto> =>
      execute(
        mutationKey("comment", [input.ref.provider_key, input.ref.id, input.body]),
        () => ({ ...input, request_id: crypto.randomUUID() }),
        (prepared) => service.comment(prepared),
      ),
  };
}

/** Client-only Tasks orchestration. Provider selection and every remote effect stay in the kernel. */
export function createTasksController(deps: TasksControllerDeps) {
  const mutations = createMutationExecutor(deps.service);
  const options = (signal?: AbortSignal): TaskCallOptions | undefined =>
    signal === undefined
      ? undefined
      : { signal: signal as unknown as NonNullable<TaskCallOptions["signal"]> };
  return {
    available: (): boolean => deps.available?.() ?? true,
    status: (signal?: AbortSignal): Promise<TaskProviderStatusDto> =>
      deps.service.status(options(signal)),
    capabilities: (signal?: AbortSignal): Promise<TaskProviderCapabilitiesDto> =>
      deps.service.capabilities(options(signal)),
    listContainers: (input: ListTaskContainersDto, signal?: AbortSignal) =>
      deps.service.listContainers(input, options(signal)),
    search: (input: SearchTasksDto, signal?: AbortSignal) =>
      deps.service.search(input, options(signal)),
    get: (ref: TaskRefDto, signal?: AbortSignal): Promise<TaskDocumentDto> =>
      deps.service.get(ref, options(signal)),
    searchActors: (input: SearchTaskActorsDto, signal?: AbortSignal) =>
      deps.service.searchActors(input, options(signal)),
    create: (input: CreateTaskCommand): Promise<TaskDocumentDto> => mutations.create(input),
    assign: (input: AssignTaskCommand): Promise<TaskDocumentDto> => mutations.assign(input),
    previewTransition: (input: PreviewTaskTransitionDto) => deps.service.previewTransition(input),
    transition: (input: TransitionTaskCommand): Promise<TaskDocumentDto> =>
      mutations.transition(input),
    comment: (input: CommentTaskCommand): Promise<TaskDocumentDto> => mutations.comment(input),
    workBlocked: (): boolean => deps.runActive(),
    workOnTask: deps.workOnTask,
  };
}

export type TasksController = ReturnType<typeof createTasksController>;
