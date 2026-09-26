import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { globalPaths } from "@clarvis/paths";
import { createAiSdkProvider } from "@clarvis/llm";
import {
  parseModelRef,
  resolveProvider,
  type ModelExecutionInfo,
  type ProviderConfig,
} from "@clarvis/capability";
import { createJudgeService, JUDGE_POLICY } from "@clarvis/judge";
import { kernelSettingsSchema, type SettingsFile } from "@clarvis/kernel/config";
import { SubscriptionManager } from "@clarvis/kernel/bootstrap";
import { createFileSecretStore } from "../../packages/kernel/src/secrets/secret-store.ts";

interface EvalCase {
  id: string;
  task: string;
  command: string;
  facts: string;
  expected: "allow" | "deny";
  reason: string;
  inspection: boolean;
}

const paths = globalPaths();
const settings = kernelSettingsSchema.parse(
  JSON.parse(readFileSync(paths.settingsFile, "utf8")),
) as SettingsFile;
const modelRef =
  process.env.CLARVIS_JUDGE_EVAL_MODEL ?? settings.judge?.model ?? settings.default_model;
if (!modelRef)
  throw new Error("Set CLARVIS_JUDGE_EVAL_MODEL or a configured default_model before eval");
const { provider, modelId } = parseModelRef(modelRef);
const providers = settings.providers as ProviderConfig[] | undefined;
const declared = providers?.find((item) => item.name === provider);
const modelConfig = declared?.models?.[modelId];
const resolution = resolveProvider(provider, providers, modelId);
if (!declared || !modelConfig || !resolution.ok)
  throw new Error("Eval model must be in the configured provider catalog");
const model: ModelExecutionInfo = {
  provider,
  model: modelId,
  kind: declared.kind,
  contextWindowTokens: modelConfig.context_window_tokens,
  maxOutputTokens: modelConfig.max_output_tokens,
  capabilities: modelConfig.capabilities,
  reasoningEfforts: modelConfig.reasoning_efforts,
  promptCache: modelConfig.prompt_cache,
};
const keys = createFileSecretStore({ dir: paths.root }).read();
if (keys.error) throw new Error(`Credential store is invalid: ${keys.error}`);
const subscriptions = new SubscriptionManager();
const providerLlm = createAiSdkProvider({
  resolveRegistryKey: (name) => process.env[name] ?? keys.values[name],
  resolveSubscription: (scheme, signal, context) => subscriptions.resolve(scheme, signal, context),
});
const business = process.argv.includes("--business");
let reviewUsage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 };
let reviewInspections = 0;
const llm = {
  async call(params: Parameters<typeof providerLlm.call>[0]) {
    const result = await providerLlm.call(params);
    reviewUsage.input_tokens += result.usage.input_tokens;
    reviewUsage.output_tokens += result.usage.output_tokens;
    reviewUsage.cached_tokens += result.usage.cached_tokens;
    reviewUsage.cache_write_tokens += result.usage.cache_write_tokens;
    reviewInspections += result.toolCalls?.length ?? 0;
    return result;
  },
};
const judge = createJudgeService({
  llm,
  model,
  providerConfig: resolution.config,
  maxAttempts: business ? (settings.judge?.max_attempts ?? 3) : 1,
  timeoutMs: settings.judge?.timeout_ms ?? 90_000,
});
const cases = JSON.parse(
  readFileSync(
    new URL(
      business
        ? "../../packages/judge/evals/business.json"
        : "../../packages/judge/eval/cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as EvalCase[];
let failures = 0;
const records: {
  id: string;
  repetition: number;
  expected: string;
  actual: string;
  latency_ms: number;
  usage: typeof reviewUsage;
  inspections: number;
  reason: string;
}[] = [];
console.log(
  `Judge eval: ${modelRef}, ${cases.length} synthetic cases, ${business ? "five repeats" : "one review"} per case`,
);
for (const item of cases) {
  for (let repetition = 1; repetition <= (business ? 5 : 1); repetition++) {
    reviewUsage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 };
    reviewInspections = 0;
    const started = performance.now();
    const result = await judge.review({
      action: {
        identity: {
          owner: "eval",
          executionId: item.id,
          actor: "lead",
          callId: "call",
          attempt: 1,
        },
        tool: "shell",
        arguments: { command: item.command },
        command: item.command,
        cwd: "/tmp/synthetic-workspace",
        requestedProfile: "sandbox",
        effectiveProfile: "sandbox",
        reason: "semantic evaluation fixture",
        policyRevision: "eval-v1",
        authorizationRevision: 0,
      },
      evidence: [
        { role: "user", content: item.task },
        { role: "tool", content: item.facts },
      ],
      profile: "sandbox",
    });
    const outcome = result.kind === "assessment" ? result.assessment.outcome : result.kind;
    const latency_ms = Math.round(performance.now() - started);
    const pass = outcome === item.expected;
    if (!pass) failures++;
    records.push({
      id: item.id,
      repetition,
      expected: item.expected,
      actual: outcome,
      latency_ms,
      usage: { ...reviewUsage },
      inspections: reviewInspections,
      reason: item.reason,
    });
    console.log(
      `${pass ? "PASS" : "FAIL"} ${item.id} #${repetition}: expected=${item.expected} actual=${outcome} inspect=${reviewInspections} latency_ms=${latency_ms} reason=${item.reason}${result.kind === "assessment" ? ` rationale=${JSON.stringify(result.assessment.rationale)}` : result.kind === "technical_failure" ? ` technical=${result.reason}` : ""}`,
    );
  }
}
if (business) {
  const latency = records.map((record) => record.latency_ms).sort((a, b) => a - b);
  const percentile = (fraction: number) => latency[Math.ceil(latency.length * fraction) - 1] ?? 0;
  console.log(
    JSON.stringify(
      {
        model: modelRef,
        policy: createHash("sha256").update(JUDGE_POLICY).digest("hex"),
        timeout_ms: settings.judge?.timeout_ms ?? 90_000,
        max_attempts: settings.judge?.max_attempts ?? 3,
        false_allow: records.filter((r) => r.expected === "deny" && r.actual === "allow").length,
        false_deny: records.filter((r) => r.expected === "allow" && r.actual === "deny").length,
        human_prompt: 0,
        technical: records.filter((r) => r.actual !== "allow" && r.actual !== "deny").length,
        latency_p50_ms: percentile(0.5),
        latency_p95_ms: percentile(0.95),
        cost: "unavailable_without_catalog_price",
        records,
      },
      null,
      2,
    ),
  );
}
if (failures) process.exitCode = 1;
await subscriptions.close();
