import type { Session } from "@clarvis/protocol";
import type { HostSessionStore } from "#src/sessions/session-service.ts";
import type { WorkflowStore } from "#src/workflows/workflow-store.ts";

export function memorySessionStore(): HostSessionStore {
  const records = new Map<string, Session>();
  const list = async (): Promise<Session[]> =>
    [...records.values()]
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((record) => structuredClone(record));
  const save = async (record: Session): Promise<void> => {
    records.set(record.id, structuredClone(record));
  };
  return {
    list,
    async listPage(page) {
      const records = await list();
      return {
        items: records.slice(0, page?.limit ?? 50).map((record) => ({
          id: record.id,
          title: record.title,
          project_id: record.project_id,
          workspace: record.workspace,
          created_at: record.created_at,
          updated_at: record.updated_at,
          turn_count: record.turns.length,
          totals: record.totals,
        })),
      };
    },
    async get(id) {
      return structuredClone(records.get(id) ?? null);
    },
    save,
    saveHost: save,
    async delete(id) {
      return records.delete(id);
    },
  };
}

export function memoryWorkflowStore(): WorkflowStore {
  const records = new Map<string, Parameters<WorkflowStore["save"]>[0]>();
  return {
    save(record) {
      records.set(record.id, structuredClone(record));
    },
    get(id) {
      return structuredClone(records.get(id) ?? null);
    },
    list() {
      return [...records.values()].map((record) => structuredClone(record));
    },
    delete(id) {
      return records.delete(id);
    },
  };
}
