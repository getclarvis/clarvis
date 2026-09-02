import type {
  ConfigService,
  CreateTaskDto,
  EnvironmentService,
  KernelCapabilities,
  KernelClient,
  KernelTransport,
  MemoryService,
  ModelCatalogService,
  PlansService,
  ProviderAuthService,
  PluginService,
  ProjectRef,
  RunDetail,
  RunEvent,
  RunHandle,
  RunService,
  SecretService,
  SessionService,
  SessionTotals,
  SettingsRepairPlan,
  SkillsService,
  StartRunParams,
  StorageService,
  TasksService,
  WorkspaceRef,
  WorkspaceService,
  WorkflowDetail,
  WorkflowSequence,
  WorkflowsService,
} from "../../src/index.ts";

const capabilities = {
  memory: true,
  skills: true,
  agent_tools: true,
  tasks: true,
} satisfies KernelCapabilities;

const unknownCacheSessionTotals = {
  input: 12_000,
  output: 800,
} satisfies SessionTotals;

const project = { id: "project-1", label: "Example" } satisfies ProjectRef;
const workspace = {
  id: "workspace-1",
  projectId: project.id,
  label: "Primary",
  kind: "primary",
  path: "/workspace",
} satisfies WorkspaceRef;

const startParams = {
  execution_id: "run-1",
  messages: [{ role: "user", content: "Inspect the workspace" }],
  plans: "review",
  task: { id: "CLAR-42", provider_key: "tasks:mcp:v1:sha256:fixture", mode: "work" },
  output_schema: { type: "object" },
} satisfies StartRunParams;

const textDelta = {
  type: "text_delta",
  at: 1,
  agent: "lead",
  iteration: 1,
  channel: "text",
  text: "Working",
  reset: false,
} satisfies RunEvent;

const repairPlan = {
  scope: "workspace",
  revision: "sha256",
  action: "strip",
  dropped: ["providers.invalid"],
} satisfies SettingsRepairPlan;

const createTask = {
  request_id: "create-stable",
  provider_key: "tasks:mcp:v2:sha256:provider-a",
  container_id: "CLAR",
  title: "Pinned create",
} satisfies CreateTaskDto;

const runDetail = {
  execution_id: "run-1",
  status: "completed",
  created_at: 1,
  messages: startParams.messages,
  events: [textDelta],
} satisfies RunDetail;

const workflowSequence = {
  session_id: "wfseq-1",
  status: "awaiting_manager",
  revision: 1,
  round_id: "discover",
  pass: 0,
  next_round_id: "verify",
  next_pass: 0,
  leaders_started: 1,
  max_total_leaders: 32,
} satisfies WorkflowSequence;

const workflowDetail = {
  execution_id: "run-1",
  status: "running",
  created_at: 1,
  updated_at: 2,
  leader_count: 1,
  nodes: [],
  sequence: workflowSequence,
} satisfies WorkflowDetail;

async function* events(): AsyncGenerator<RunEvent> {
  yield textDelta;
}

const runHandle = {
  execution_id: "run-1",
  events: events(),
  async steer(message) {
    void message;
  },
  async compact(request) {
    void request;
  },
  async cancel() {},
  async respond(response) {
    void response;
  },
  onElicit(handler) {
    void handler;
  },
  done: Promise.resolve({ execution_id: "run-1", status: "completed" }),
  closed: Promise.resolve(),
} satisfies RunHandle;

const runs = {
  async start(params) {
    void params;
    return runHandle;
  },
  async compact(executionId, request, options) {
    void request;
    void options;
    return { status: "queued" as const, execution_id: executionId };
  },
  async context(executionId, targetWindowTokens) {
    void targetWindowTokens;
    return { execution_id: executionId, estimated_tokens: 0, has_context: false };
  },
  async get(executionId) {
    void executionId;
    return runDetail;
  },
  async list(page) {
    return {
      items: [runDetail],
      total: 1,
      limit: page?.limit ?? 20,
      offset: page?.offset ?? 0,
    };
  },
  async delete(executionId) {
    void executionId;
  },
} satisfies RunService;

const secrets = {
  async listNames() {
    return ["PROVIDER_API_KEY"];
  },
  async set(name, value) {
    void name;
    void value;
  },
  async delete(name) {
    void name;
  },
} satisfies SecretService;

const transport = {
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    void method;
    void params;
    throw new Error("compile-time fixture");
  },
  notify(method, params) {
    void method;
    void params;
  },
  onNotification(method, handler) {
    void method;
    void handler;
    return () => {};
  },
  onClose(handler) {
    void handler;
    return () => {};
  },
  async close() {},
} satisfies KernelTransport;

declare const config: ConfigService;
declare const environments: EnvironmentService;
declare const plugins: PluginService;
declare const models: ModelCatalogService;
declare const providerAuth: ProviderAuthService;
declare const files: WorkspaceService;
declare const memory: MemoryService;
declare const plans: PlansService;
declare const workflows: WorkflowsService;
declare const skills: SkillsService;
declare const sessions: SessionService;
declare const tasks: TasksService;
declare const storage: StorageService;

const client = {
  capabilities,
  project,
  workspace,
  runs,
  config,
  environments,
  plugins,
  secrets,
  models,
  providerAuth,
  files,
  memory,
  plans,
  workflows,
  skills,
  sessions,
  tasks,
  storage,
  async close() {},
} satisfies KernelClient;

void client;
void repairPlan;
void createTask;
void transport;
void unknownCacheSessionTotals;
void workflowDetail;
