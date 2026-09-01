import type { ConfigChange, ConfigChangeKind } from "@clarvis/protocol";
import type { KernelServices } from "../../src/transport/operations.ts";

/** Error identity used to stop an operation immediately after recording dispatch. */
export const RECORDED_OPERATION = new Error("recorded kernel operation");

/**
 * Complete protocol-service fake for transport catalog tests.
 *
 * Every async method records its service-qualified name and rejects with the
 * same sentinel. A descriptor test can therefore execute every encoder and
 * dispatcher without inventing valid CRUD results or casting a partial proxy to
 * the complete service surface.
 */
export function createRecordingKernelServices(invoked: string[]): KernelServices {
  const record = (name: string) => (): Promise<never> => {
    invoked.push(name);
    return Promise.reject(RECORDED_OPERATION);
  };

  return {
    runs: {
      start: record("runs.start"),
      compact: record("runs.compact"),
      get: record("runs.get"),
      context: record("runs.context"),
      list: record("runs.list"),
      delete: record("runs.delete"),
    },
    config: {
      getSettings: record("config.getSettings"),
      previewSettingsRepair: record("config.previewSettingsRepair"),
      repairSettings: record("config.repairSettings"),
      approveWorkspace: record("config.approveWorkspace"),
      revokeWorkspace: record("config.revokeWorkspace"),
      workspaceTrustError: record("config.workspaceTrustError"),
      updateSettings: record("config.updateSettings"),
      inspectSandbox: record("config.inspectSandbox"),
      listAgents: record("config.listAgents"),
      getAgent: record("config.getAgent"),
      writeAgent: record("config.writeAgent"),
      deleteAgent: record("config.deleteAgent"),
      renameAgent: record("config.renameAgent"),
      getContext: record("config.getContext"),
      subscribe(_kinds: ConfigChangeKind[], _listener: (change: ConfigChange) => void): () => void {
        invoked.push("config.subscribe");
        return () => {};
      },
    },
    plugins: {
      list: record("plugins.list"),
      install: record("plugins.install"),
      installSource: record("plugins.installSource"),
      update: record("plugins.update"),
      uninstall: record("plugins.uninstall"),
    },
    environments: {
      list: record("environments.list"),
      current: record("environments.current"),
      get: record("environments.get"),
      inventory: record("environments.inventory"),
      preview: record("environments.preview"),
      previewClear: record("environments.previewClear"),
      previewComposition: record("environments.previewComposition"),
      select: record("environments.select"),
      clearSelection: record("environments.clearSelection"),
      applyComposition: record("environments.applyComposition"),
      create: record("environments.create"),
      update: record("environments.update"),
      delete: record("environments.delete"),
      clone: record("environments.clone"),
    },
    secrets: {
      listNames: record("secrets.listNames"),
      set: record("secrets.set"),
      delete: record("secrets.delete"),
    },
    models: {
      get: record("models.get"),
      refresh: record("models.refresh"),
      getEntitled: record("models.getEntitled"),
      refreshEntitled: record("models.refreshEntitled"),
    },
    providerAuth: {
      list: record("providerAuth.list"),
      startDevice: record("providerAuth.startDevice"),
      wait: record("providerAuth.wait"),
      cancel: record("providerAuth.cancel"),
      disconnect: record("providerAuth.disconnect"),
    },
    files: {
      listFiles: record("files.listFiles"),
      readFile: record("files.readFile"),
      readImage: record("files.readImage"),
    },
    memory: {
      health: record("memory.health"),
      reindex: record("memory.reindex"),
      jobs: record("memory.jobs"),
      retryJob: record("memory.retryJob"),
    },
    plans: {
      list: record("plans.list"),
      read: record("plans.read"),
      setRetention: record("plans.setRetention"),
      delete: record("plans.delete"),
    },
    workflows: {
      get: record("workflows.get"),
      list: record("workflows.list"),
      delete: record("workflows.delete"),
    },
    skills: {
      list: record("skills.list"),
      getPrompt: record("skills.getPrompt"),
    },
    sessions: {
      listPage: record("sessions.listPage"),
      list: record("sessions.list"),
      get: record("sessions.get"),
      save: record("sessions.save"),
      delete: record("sessions.delete"),
    },
    tasks: {
      status: record("tasks.status"),
      capabilities: record("tasks.capabilities"),
      listContainers: record("tasks.listContainers"),
      search: record("tasks.search"),
      get: record("tasks.get"),
      searchActors: record("tasks.searchActors"),
      create: record("tasks.create"),
      assign: record("tasks.assign"),
      previewTransition: record("tasks.previewTransition"),
      transition: record("tasks.transition"),
      comment: record("tasks.comment"),
      attachArtifact: record("tasks.attachArtifact"),
    },
    storage: {
      inspect: record("storage.inspect"),
      cleanup: record("storage.cleanup"),
    },
  };
}
