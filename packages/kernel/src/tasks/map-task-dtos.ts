import type {
  TaskActor,
  TaskActorPage,
  TaskContainerPage,
  TaskDocument,
  TaskPage,
  TaskProviderCapabilities,
  TaskRef,
  TaskSummary,
} from "@clarvis/tasks";
import type {
  TaskActorDto,
  TaskActorPageDto,
  TaskContainerPageDto,
  TaskDocumentDto,
  TaskPageDto,
  TaskProviderCapabilitiesDto,
  TaskRefDto,
  TaskSummaryDto,
} from "@clarvis/protocol";

export function taskRefFromDto(value: TaskRefDto): TaskRef {
  return { providerKey: value.provider_key, id: value.id };
}

function taskRefDto(value: TaskRef): TaskRefDto {
  return { provider_key: value.providerKey, id: value.id };
}

function taskActorDto(value: TaskActor): TaskActorDto {
  return { id: value.id, label: value.label, kind: value.kind };
}

function taskSummaryDto(value: TaskSummary): TaskSummaryDto {
  return {
    ref: taskRefDto(value.ref),
    container: value.container,
    title: value.title,
    stage: value.stage,
    native_state: value.nativeState,
    ...(value.priority === undefined ? {} : { priority: value.priority }),
    ...(value.assignee === undefined ? {} : { assignee: taskActorDto(value.assignee) }),
    ...(value.claim === undefined
      ? {}
      : {
          claim: {
            claimant: taskActorDto(value.claim.claimant),
            execution_id: value.claim.executionId,
            claimed_at: value.claim.claimedAt,
          },
        }),
    labels: [...value.labels],
    ...(value.updatedAt === undefined ? {} : { updated_at: value.updatedAt }),
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(value.url === undefined ? {} : { url: value.url }),
  };
}

export function taskDocumentDto(value: TaskDocument): TaskDocumentDto {
  return {
    ...taskSummaryDto(value),
    ...(value.description === undefined ? {} : { description: value.description }),
    acceptance_criteria: [...value.acceptanceCriteria],
    available_intents: [...value.availableIntents],
  };
}

export function taskCapabilitiesDto(value: TaskProviderCapabilities): TaskProviderCapabilitiesDto {
  return {
    protocol_version: value.protocolVersion,
    provider_instance_id: value.providerInstanceId,
    provider_kind: value.providerKind,
    read: value.read,
    write: {
      create: value.write.create,
      assign: value.write.assign,
      comment: value.write.comment,
      attach_artifact: value.write.attachArtifact,
      intents: [...value.write.intents],
    },
    concurrency: value.concurrency,
  };
}

export function taskContainerPageDto(value: TaskContainerPage): TaskContainerPageDto {
  return {
    items: value.items.map((item) => ({ ...item })),
    ...(value.nextCursor === undefined ? {} : { next_cursor: value.nextCursor }),
  };
}

export function taskPageDto(value: TaskPage): TaskPageDto {
  return {
    items: value.items.map(taskSummaryDto),
    ...(value.nextCursor === undefined ? {} : { next_cursor: value.nextCursor }),
  };
}

export function taskActorPageDto(value: TaskActorPage): TaskActorPageDto {
  return {
    items: value.items.map(taskActorDto),
    ...(value.nextCursor === undefined ? {} : { next_cursor: value.nextCursor }),
  };
}
