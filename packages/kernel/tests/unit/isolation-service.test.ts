import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { globalPaths } from "@clarvis/paths";
import type { ActionAuthorizationRequest } from "@clarvis/capability";
import { createMemoryConfigStore } from "../../src/config/memory-config-store.ts";
import {
  createIsolationService,
  executeWithIsolationBinding,
} from "../../src/execution/isolation-service.ts";

test("run bindings retain global preference and separate owners", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-isolation-run-"));
  const homeRoot = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  const globalRoot = join(homeRoot, ".clarvis");
  const scratchRoot = join(root, "scratch");
  for (const path of [homeRoot, workspaceRoot, globalRoot, scratchRoot]) mkdirSync(path);
  const store = createMemoryConfigStore({
    settings: {
      global: {
        isolation: { mode: "sandbox", workspace: "read-only", network: "disabled" },
      },
    },
  });
  const service = createIsolationService({ store, homeRoot, workspaceRoot, globalRoot });
  const context = (owner: string, executionId: string) =>
    ({ owner, executionId }) as Parameters<typeof service.resolveExecution>[0];

  service.bind("owner-a", "run");
  store.writeSettings("global", { isolation: { mode: "host" } });
  service.bind("owner-b", "run");
  service.inherit("owner-a", "run", "leader");
  const original = await service.resolveExecution(context("owner-a", "run"), scratchRoot);
  const leader = await service.resolveExecution(context("owner-a", "leader"), scratchRoot);
  const next = await service.resolveExecution(context("owner-b", "run"), scratchRoot);
  expect(original.executionPolicy).toMatchObject({
    mode: "sandbox",
    workspaceAccess: "read-only",
    network: "disabled",
  });
  expect(original.executionPolicy?.installationRoots).toContain(
    dirname(realpathSync(process.execPath)),
  );
  expect(leader.executionPolicy).toMatchObject({
    mode: "sandbox",
    workspaceAccess: "read-only",
    network: "disabled",
  });
  expect(next.executionPolicy).toMatchObject({ mode: "host" });
  expect(original.actionAuthorization).toBeDefined();
  expect(next.actionAuthorization).toBeDefined();
  const hostGrant = original.selectAuthorizedExecution?.({ host: true });
  expect(hostGrant?.executionPolicy?.mode).toBe("host");
  const networkGrant = original.selectAuthorizedExecution?.({
    network: "enabled",
    writeRoots: [scratchRoot],
  });
  expect(networkGrant?.executionPolicy?.mode).toBe("sandbox");
  expect(networkGrant?.executionPolicy?.network).toBe("enabled");
  const approval = await service.resolveAuthorization(context("owner-a", "run"));
  expect(approval.revision()).toBe(0);
  expect(() => service.steer("owner-a", "run", "yes", { call_id: "missing", attempt: 1 })).toThrow(
    "denied action is unavailable",
  );
  expect(approval.revision()).toBe(0);
  service.steer("owner-a", "run");
  expect(approval.revision()).toBe(1);
  const observe = original.executionPort as unknown as {
    onAvailability?: (ready: boolean) => void;
  };
  observe.onAvailability?.(true);
  store.writeSettings("global", {
    isolation: { mode: "host", network: "enabled" },
  });
  expect(service.availability()).toBe("unverified");
  store.writeSettings("global", {
    isolation: { mode: "sandbox", network: "disabled" },
  });
  expect(service.availability()).toBe("available");
  service.release("owner-a", "run");
  await expect(service.resolveExecution(context("owner-a", "run"), scratchRoot)).rejects.toThrow(
    "binding is missing",
  );
  service.release("owner-a", "leader");
  service.release("owner-b", "run");
});

test("internal runs bind the owner and release the identity after execution", async () => {
  const active = new Set<string>();
  const service = {
    bind(owner: string, id: string) {
      active.add(`${owner}:${id}`);
    },
    release(owner: string, id: string) {
      active.delete(`${owner}:${id}`);
    },
  } as Parameters<typeof executeWithIsolationBinding>[0];
  const args = {
    owner: "goal-owner",
    rawBody: { execution_id: "goal-run" },
  } as Parameters<typeof executeWithIsolationBinding>[1];
  await expect(
    executeWithIsolationBinding(service, args, async () => {
      expect(active.has("goal-owner:goal-run")).toBe(true);
      throw new Error("run failed");
    }),
  ).rejects.toThrow("run failed");
  expect(active.size).toBe(0);
  await expect(
    executeWithIsolationBinding(service, { ...args, rawBody: {} }, async () => {
      throw new Error("must not execute");
    }),
  ).rejects.toThrow("requires an execution id");
  expect(active.size).toBe(0);
});

test("approval mode edits publish a new revision for future actions in the bound run", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-approval-switch-"));
  const globalRoot = join(root, "global");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(globalRoot);
  mkdirSync(workspaceRoot);
  const store = createMemoryConfigStore({ settings: { global: { approval_mode: "manual" } } });
  const service = createIsolationService({ store, globalRoot, workspaceRoot });
  service.bind("owner", "run");
  const port = await service.resolveAuthorization({
    owner: "owner",
    executionId: "run",
  } as Parameters<typeof service.resolveAuthorization>[0]);
  const initial = port.policyRevision;
  expect(port.revision()).toBe(0);
  store.writeSettings("global", { approval_mode: "auto" });
  expect(port.revision()).toBe(1);
  expect(port.policyRevision).not.toBe(initial);
  store.writeSettings("global", { approval_mode: "manual" });
  expect(port.revision()).toBe(2);
  expect(port.policyRevision).toBe(initial);
  service.release("owner", "run");
  rmSync(root, { recursive: true, force: true });
});

test("remembered manual approval persists the exact argv prefix for later actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-remember-run-"));
  const globalRoot = join(root, "global");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(globalRoot);
  mkdirSync(workspaceRoot);
  const store = createMemoryConfigStore({ settings: { global: { approval_policy: "untrusted" } } });
  const service = createIsolationService({ store, globalRoot, workspaceRoot });
  service.bind("owner", "run");
  try {
    const port = await service.resolveAuthorization({
      owner: "owner",
      executionId: "run",
      elicit: async () => ({ action: "accept", content: { approved: "remember" } }),
    } as unknown as Parameters<typeof service.resolveAuthorization>[0]);
    const request: ActionAuthorizationRequest = {
      identity: { owner: "owner", executionId: "run", actor: "lead", callId: "call", attempt: 1 },
      tool: "shell",
      arguments: { command: "git status" },
      command: "git status",
      cwd: workspaceRoot,
      requestedProfile: "sandbox",
      effectiveProfile: "sandbox",
      reason: "test",
      policyRevision: port.policyRevision,
      authorizationRevision: port.revision(),
    };
    const approved = await port.authorize(request);
    expect(approved.granted).toBe(true);
    expect(approved.evidence.reason).toBe("review_approved_remembered");
    const document = JSON.parse(readFileSync(globalPaths(globalRoot).executionRulesFile, "utf8"));
    expect(document.rules).toMatchObject([{ pattern: ["git", "status"], decision: "allow" }]);
  } finally {
    service.release("owner", "run");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a judge denial can carry one operator retry into a fresh review", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-judge-retry-"));
  const globalRoot = join(root, "global");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(globalRoot);
  mkdirSync(workspaceRoot);
  const store = createMemoryConfigStore({ settings: { global: { approval_mode: "auto" } } });
  const service = createIsolationService({ store, globalRoot, workspaceRoot });
  const prompts: string[] = [];
  service.bind("owner", "run");
  try {
    const port = await service.resolveAuthorization({
      owner: "owner",
      executionId: "run",
      request: {
        entry: "lead",
        profiles: [{ name: "lead", model: "fixture/reviewer" }],
        providers: [
          {
            name: "fixture",
            kind: "openai-compatible",
            models: {
              reviewer: { context_window_tokens: 8192, max_output_tokens: 512, capabilities: [] },
            },
          },
        ],
        messages: [{ role: "user", content: "Do a safe local check" }],
      },
      llm: {
        async call(params: { messages: Array<{ content: string }> }) {
          prompts.push(params.messages.at(-1)?.content ?? "");
          return {
            text: JSON.stringify({ outcome: "deny", rationale: "not yet authorized" }),
            usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
          };
        },
      },
    } as unknown as Parameters<typeof service.resolveAuthorization>[0]);
    const request: ActionAuthorizationRequest = {
      identity: { owner: "owner", executionId: "run", actor: "lead", callId: "first", attempt: 1 },
      tool: "shell",
      arguments: { command: "echo check" },
      command: "echo check",
      cwd: workspaceRoot,
      requestedProfile: "sandbox",
      effectiveProfile: "sandbox",
      permissions: { network: "enabled" },
      reason: "test",
      policyRevision: port.policyRevision,
      authorizationRevision: port.revision(),
    };
    expect((await port.authorize(request)).granted).toBe(false);
    service.steer("owner", "run", undefined, { call_id: "first", attempt: 1 });
    const retry = {
      ...request,
      identity: { ...request.identity, callId: "second", attempt: 2 },
      authorizationRevision: port.revision(),
      policyRevision: port.policyRevision,
    };
    expect((await port.authorize(retry)).granted).toBe(false);
    expect(prompts.some((prompt) => prompt.includes("operator authorized one new attempt"))).toBe(
      true,
    );
  } finally {
    service.release("owner", "run");
    rmSync(root, { recursive: true, force: true });
  }
});
