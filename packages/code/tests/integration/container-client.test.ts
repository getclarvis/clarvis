import { describe, expect, it } from "bun:test";
import { connectKernelClient, kernelError } from "@clarvis/kernel";
import type { KernelClient, KernelTransport, ResolvedExtensionProfile } from "@clarvis/protocol";
import {
  composeContainerClient,
  type ComposeContainerClientOptions,
} from "../../src/adapters/container-client.ts";

const routes = {
  capabilities: "validated",
  principal: "validated",
  project: "validated",
  workspace: "validated",
  runs: "guest",
  hosting: "guest",
  localHost: "absent",
  config: "operator_wrapped",
  plugins: "unavailable",
  extensionProfiles: "guest",
  secrets: "operator",
  models: "operator_wrapped",
  providerAuth: "operator",
  files: "guest",
  changes: "guest",
  memory: "guest",
  plans: "guest",
  goals: "guest",
  workflows: "guest",
  skills: "unavailable",
  sessions: "guest",
  tasks: "unavailable",
  storage: "guest",
  close: "lifecycle",
} as const satisfies Record<
  keyof KernelClient,
  "guest" | "operator" | "operator_wrapped" | "validated" | "unavailable" | "absent" | "lifecycle"
>;

const profile: ResolvedExtensionProfile = {
  id: "builtin:default",
  ref: { scope: "builtin", name: "default" },
  immutable: true,
  status: "ready",
  fingerprint: "sha256:" + "0".repeat(64),
  selection_origin: "builtin",
  plugins: [],
  standalone_skills: [],
  issues: [],
  counts: {
    plugins_active: 0,
    standalone_skills_active: 0,
    plugin_skills_active: 0,
    mcp_servers_active: 0,
    hooks_declared: 0,
  },
};

async function fixture() {
  const project = { id: "project" };
  const workspace = {
    id: "workspace",
    projectId: project.id,
    label: "selected",
    kind: "primary",
    path: "/workspace",
  } as const;
  const principal = { id: "operator" };
  const capabilities: ComposeContainerClientOptions["capabilities"] = {
    memory: true,
    skills: false,
    agent_tools: true,
    tasks: false,
    goals: true,
    hosting: { host_generation: "guest-generation", default_owner: "owner" },
    runtime: {
      kind: "container",
      engine: "docker",
      host_platform: "linux",
      guest_platform: "linux",
      network: "outbound",
      generation: "00000000-0000-4000-8000-000000000000",
      image_digest: `sha256:${"a".repeat(64)}`,
      artifact_digest: `sha256:${"b".repeat(64)}`,
      base_abi: "clarvis-linux-glibc-v1",
      broker_version: 1,
      channel_version: 1,
      state_namespace: "c".repeat(64),
      lifecycle: "ready",
    },
  };
  const calls: string[] = [];
  let closed = 0;
  const transport: KernelTransport = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push(method);
      if (method === "hello") {
        return {
          wire_version: (params as { wire_version: number }).wire_version,
          project,
          workspace,
          principal,
          capabilities,
        } as T;
      }
      if (method === "extensionProfiles.current") return structuredClone(profile) as T;
      throw kernelError("unsupported", "Guest operation unavailable");
    },
    notify() {},
    onNotification: () => () => {},
    async close() {
      closed++;
    },
  };
  const execution = await connectKernelClient(transport);
  const operatorCalls: string[] = [];
  const operator = {
    config: {
      async listAgents() {
        operatorCalls.push("config");
        return [];
      },
    } as unknown as KernelClient["config"],
    secrets: {
      async listNames() {
        operatorCalls.push("secrets");
        return [];
      },
    } as unknown as KernelClient["secrets"],
    models: {
      async get() {
        operatorCalls.push("models");
        return { providers: [], source: "bundle" as const };
      },
    } as unknown as KernelClient["models"],
    providerAuth: {
      async list() {
        operatorCalls.push("providerAuth");
        return [];
      },
    } as unknown as KernelClient["providerAuth"],
  };
  const options: ComposeContainerClientOptions = {
    execution,
    operator,
    project,
    workspace,
    principal,
    capabilities,
  };
  const client = composeContainerClient(options);
  return { options, client, execution, operator, calls, operatorCalls, closed: () => closed };
}

describe("composeContainerClient", () => {
  it("routes every KernelClient key explicitly and omits remote utility/local-host members", async () => {
    const f = await fixture();
    try {
      expect(Object.keys(f.client).sort()).toEqual(
        Object.keys(routes)
          .filter((k) => k !== "localHost")
          .sort(),
      );
      for (const key of Object.keys(routes) as (keyof KernelClient)[]) {
        const route = routes[key];
        if (route === "guest") expect(f.client[key]).toBe(f.execution[key]);
        else if (route === "operator") {
          expect(f.client[key]).toBe(f.operator[key as keyof typeof f.operator]);
          expect(f.client[key]).not.toBe(f.execution[key]);
        } else if (route === "operator_wrapped") {
          expect(f.client[key]).not.toBe(f.operator[key as keyof typeof f.operator]);
          expect(f.client[key]).not.toBe(f.execution[key]);
        } else if (route === "validated")
          expect(f.client[key]).toEqual(
            f.options[key as "capabilities" | "principal" | "project" | "workspace"],
          );
        else if (route === "unavailable") expect(f.client[key]).not.toBe(f.execution[key]);
        else if (route === "absent") expect(key in f.client).toBe(false);
        else expect(f.client.close === f.execution.close).toBe(false);
      }
      expect("listAgents" in f.client).toBe(false);
      expect("local_host" in f.client.capabilities).toBe(false);
    } finally {
      await f.client.close();
    }
  });

  it("dispatches administration only through the exact host objects", async () => {
    const f = await fixture();
    try {
      await f.client.config.listAgents();
      await f.client.secrets.listNames();
      await f.client.models.get();
      await f.client.providerAuth.list();
      expect(f.operatorCalls).toEqual(["config", "secrets", "models", "providerAuth"]);
      expect(f.calls).toEqual(["hello"]);
    } finally {
      await f.client.close();
    }
  });

  it("does not even read guest administrative or machine-local service properties", async () => {
    const f = await fixture();
    try {
      const execution: KernelClient = { ...f.execution };
      for (const key of ["config", "secrets", "models", "providerAuth", "localHost"] as const) {
        Object.defineProperty(execution, key, {
          get() {
            throw new Error(`Guest ${key} must not be accessed`);
          },
        });
      }
      const client = composeContainerClient({ ...f.options, execution });
      await client.config.listAgents();
      expect(client.config).not.toBe(f.operator.config);
      expect("localHost" in client).toBe(false);
      expect(f.calls).toEqual(["hello"]);
    } finally {
      await f.client.close();
    }
  });

  it("marks committed host configuration and catalog refreshes pending for the next generation", async () => {
    const f = await fixture();
    const changed: string[] = [];
    const config = {
      ...f.operator.config,
      updateSettings: async () => ({}) as never,
      writeAgent: async () => ({}) as never,
      writeSharedPrompt: async () => ({}) as never,
    } as KernelClient["config"];
    const models = {
      ...f.operator.models,
      refresh: async () => ({ providers: [], source: "cache" as const }),
    } as KernelClient["models"];
    const client = composeContainerClient({
      ...f.options,
      operator: { ...f.operator, config, models },
      onConfigurationSaved: (kind) => changed.push(kind),
    });
    await client.config.updateSettings("global", {}, null);
    await client.config.writeAgent("global", "test", { frontmatter: {}, body: "test" });
    await client.config.writeSharedPrompt("global", { mode: "replace", body: "test" });
    await client.models.refresh();
    expect(changed).toEqual(["settings", "agents", "context", "models"]);
    await client.close();
  });

  it("keeps the immutable guest Extension Profile current functional over public transport", async () => {
    const f = await fixture();
    try {
      expect(await f.client.extensionProfiles.current()).toEqual(profile);
      expect(f.calls).toEqual(["hello", "extensionProfiles.current"]);
      await expect(
        f.client.extensionProfiles.delete(
          { scope: "workspace", name: "custom" },
          { expected_revision: "old" },
        ),
      ).rejects.toMatchObject({ code: "unsupported" });
    } finally {
      await f.client.close();
    }
  });

  it("keeps disabled catalogs empty and rejects all other disabled operations without guest dispatch", async () => {
    const f = await fixture();
    try {
      expect(await f.client.plugins.list()).toEqual([]);
      expect(await f.client.skills.list()).toEqual([]);
      expect(await f.client.tasks.status()).toMatchObject({
        state: "unavailable",
        writes: "disabled",
      });
      for (const [service, exceptions] of [
        [f.client.plugins, ["list"]],
        [f.client.skills, ["list"]],
        [f.client.tasks, ["status"]],
      ] as const) {
        for (const [method, operation] of Object.entries(service)) {
          if ((exceptions as readonly string[]).includes(method)) continue;
          await expect((operation as () => Promise<unknown>)()).rejects.toMatchObject({
            code: "unsupported",
          });
        }
      }
      expect(f.calls).toEqual(["hello"]);
    } finally {
      await f.client.close();
    }
  });

  it("rejects identity mismatches and capability escalation", async () => {
    const f = await fixture();
    try {
      const invalid: Partial<ComposeContainerClientOptions>[] = [
        { project: { id: "other" } },
        { workspace: { ...f.options.workspace, id: "other" } },
        { workspace: { ...f.options.workspace, projectId: "other" } },
        {
          workspace: {
            ...f.options.workspace,
            path: "/host",
          } as ComposeContainerClientOptions["workspace"],
        },
        { principal: { id: "other" } },
        ...[
          { skills: true },
          { tasks: true },
          { local_host: true as const },
          { goals: false },
          { hosting: { host_generation: "other" } },
        ].map((patch) => ({ capabilities: { ...f.options.capabilities, ...patch } })),
        {
          execution: {
            ...f.execution,
            capabilities: { ...f.execution.capabilities, agent_tools: false },
          },
        },
        {
          execution: {
            ...f.execution,
            capabilities: { ...f.execution.capabilities, memory: false },
          },
        },
        {
          execution: {
            ...f.execution,
            capabilities: { ...f.execution.capabilities, goals: false },
          },
        },
      ];
      for (const patch of invalid)
        expect(() => composeContainerClient({ ...f.options, ...patch })).toThrow();
      expect(f.calls).toEqual(["hello"]);
    } finally {
      await f.client.close();
    }
  });

  it("allows a lower agent-tool ceiling, snapshots metadata, and omits unadvertised hosting", async () => {
    const f = await fixture();
    try {
      const capabilities = { ...f.options.capabilities, agent_tools: false, goals: false };
      delete capabilities.hosting;
      const client = composeContainerClient({ ...f.options, capabilities });
      capabilities.agent_tools = true;
      expect(client.capabilities.agent_tools).toBe(false);
      expect(client.capabilities.goals).toBe(false);
      expect("hosting" in client).toBe(false);
      expect(client.workspace.path).toBe("/workspace");
      expect(Object.isFrozen(client.capabilities.runtime)).toBe(true);
    } finally {
      await f.client.close();
    }
  });

  it("closes the guest once and releases launcher resources even after failure", async () => {
    const f = await fixture();
    let released = 0;
    let attempts = 0;
    const client = composeContainerClient({
      ...f.options,
      execution: {
        ...f.execution,
        async close() {
          attempts++;
          await f.execution.close();
          throw new Error("close failed");
        },
      },
      dispose: async () => {
        released++;
      },
    });
    const first = client.close();
    expect(client.close()).toBe(first);
    await expect(first).rejects.toThrow("close failed");
    await expect(client.close()).rejects.toThrow("close failed");
    expect(attempts).toBe(1);
    expect(f.closed()).toBe(1);
    expect(released).toBe(1);
    expect(f.operatorCalls).toEqual([]);
  });
});
