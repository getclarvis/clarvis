import { afterEach, expect, test } from "bun:test";
import {
  createCapabilityServices,
  loadEnv,
  OPERATOR_AUTHORITY_PORT,
  type RunCapabilityContext,
} from "@clarvis/capability";
import { configurationRoots } from "@clarvis/paths";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigStore } from "../../src/config/config-store.ts";
import { createAuthoringMutationReview } from "../../src/configuration/authoring-mutations.ts";
import { createOperatorAuthorityRuntime } from "../../src/guard/operator-authority.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("revocation after configuration review prevents the commit", async () => {
  const home = mkdtempSync(join(tmpdir(), "clarvis-authoring-revocation-"));
  temporary.push(home);
  const workspaceRoot = join(home, "workspace");
  const globalDir = join(home, "global");
  mkdirSync(workspaceRoot);
  mkdirSync(globalDir);
  const roots = configurationRoots({ home, workspaceRoot, globalDir });
  const target = join(roots.workspace_clarvis, "shared-agent.md");
  mkdirSync(roots.workspace_clarvis);
  const services = createCapabilityServices();
  const ledger = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [
        { id: "operator", source: "start", text: "Update shared agent", execution_id: "run" },
      ],
    },
  });
  services.provide(OPERATOR_AUTHORITY_PORT, ledger.reader);
  let prompts = 0;
  const ctx = {
    services,
    workspaceRoot,
    env: loadEnv({}),
    request: { guard_mode: "on" },
    requestParam: () => undefined,
    elicit: async () => {
      prompts++;
      return { action: "accept", content: { decision: "allow" } };
    },
  } as unknown as RunCapabilityContext;
  const store = {
    readSettings: () => ({ merged: {} }),
    withOperatorWrite: <T>(_scope: string, write: () => T): T => {
      ledger.finalize({ status: "cancelled" });
      return write();
    },
  } as unknown as ConfigStore;
  const review = createAuthoringMutationReview(ctx, {
    roots,
    store,
    changed: () => {},
    prepareSkillInclusion: () => undefined,
  });
  let committed = false;
  await expect(
    review([{ type: "create", path: target, content: "Review tests.\n" }], async () => {
      committed = true;
      writeFileSync(target, "Review tests.\n");
    }),
  ).rejects.toThrow("Configuration authority changed before commit");
  expect(prompts).toBe(1);
  expect(committed).toBe(false);
  expect(existsSync(target)).toBe(false);
});
