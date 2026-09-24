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
import type { ResolvedFilesystemPolicy } from "@clarvis/tools/sandbox";
import { scanSmallTree } from "@clarvis/tools";
import { JUDGE_PORT } from "@clarvis/judge";
import { judgePort } from "../helpers/judge-port.ts";
import type { GuardEffectFact } from "../../src/guard/effects/types.ts";

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

test("Approval mode reviews an empty configuration directory before removal", async () => {
  const home = mkdtempSync(join(tmpdir(), "clarvis-authoring-rmdir-"));
  temporary.push(home);
  const workspaceRoot = join(home, "workspace");
  const globalDir = join(home, "global");
  mkdirSync(workspaceRoot);
  mkdirSync(globalDir);
  const roots = configurationRoots({ home, workspaceRoot, globalDir });
  const target = join(roots.workspace_agents, "skills", "agent-probe");
  mkdirSync(target, { recursive: true });
  const services = createCapabilityServices();
  const ledger = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [
        { id: "operator", source: "start", text: "Clean test skill", execution_id: "run" },
      ],
    },
  });
  services.provide(OPERATOR_AUTHORITY_PORT, ledger.reader);
  let questions = 0;
  let mutateDuringReview = false;
  let removeDuringReview = false;
  const ctx = {
    services,
    workspaceRoot,
    env: loadEnv({}),
    request: { guard_mode: "on" },
    requestParam: () => undefined,
    elicit: async () => {
      questions++;
      expect(existsSync(target)).toBe(true);
      if (mutateDuringReview) writeFileSync(join(target, "raced.txt"), "new entry");
      if (removeDuringReview) rmSync(target, { recursive: true });
      return { action: "accept", content: { decision: "allow" } };
    },
  } as unknown as RunCapabilityContext;
  const changed: string[] = [];
  const review = createAuthoringMutationReview(ctx, {
    roots,
    store: { readSettings: () => ({ merged: {} }) } as unknown as ConfigStore,
    changed: (path) => changed.push(path),
    prepareSkillInclusion: () => undefined,
  });
  const policy = {
    placement: "sandbox",
    workspaceAccess: "workspace-write",
    protectedRoots: [],
  } as unknown as ResolvedFilesystemPolicy;
  const operation = [{ type: "rmdir" as const, path: target }];
  await review(operation, () => review.commitClassified!(operation, policy));
  expect(questions).toBe(1);
  expect(existsSync(target)).toBe(false);
  expect(changed).toEqual([target]);

  mkdirSync(target);
  mutateDuringReview = true;
  await expect(
    review(operation, () => review.commitClassified!(operation, policy)),
  ).rejects.toMatchObject({
    code: "revision_conflict",
  });
  expect(questions).toBe(2);
  expect(existsSync(join(target, "raced.txt"))).toBe(true);
  expect(changed).toEqual([target]);

  rmSync(target, { recursive: true });
  mkdirSync(target);
  mutateDuringReview = false;
  removeDuringReview = true;
  await expect(
    review(operation, () => review.commitClassified!(operation, policy)),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(existsSync(target)).toBe(false);
  expect(changed).toEqual([target]);
});

test("recursive workspace cleanup previews every entry in Approval mode", async () => {
  const home = mkdtempSync(join(tmpdir(), "clarvis-authoring-tree-"));
  temporary.push(home);
  const workspaceRoot = join(home, "workspace");
  const globalDir = join(home, "global");
  const target = join(workspaceRoot, "probe");
  mkdirSync(join(target, "nested"), { recursive: true });
  mkdirSync(globalDir);
  writeFileSync(join(target, "nested", "a.txt"), "one");
  const roots = configurationRoots({ home, workspaceRoot, globalDir });
  const services = createCapabilityServices();
  const ledger = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [{ id: "operator", source: "start", text: "Clean test tree", execution_id: "run" }],
    },
  });
  services.provide(OPERATOR_AUTHORITY_PORT, ledger.reader);
  let message = "";
  let options: unknown;
  let race = false;
  let vanish = false;
  const ctx = {
    services,
    workspaceRoot,
    env: loadEnv({}),
    request: { guard_mode: "on" },
    requestParam: () => undefined,
    elicit: async (request: { message: string; requestedSchema: unknown }) => {
      message = request.message;
      options = request.requestedSchema;
      if (race) writeFileSync(join(target, "nested", "raced.txt"), "two");
      if (vanish) rmSync(target, { recursive: true });
      return { action: "accept", content: { decision: "allow" } };
    },
  } as unknown as RunCapabilityContext;
  const changed: string[] = [];
  const review = createAuthoringMutationReview(ctx, {
    roots,
    store: { readSettings: () => ({ merged: {} }) } as unknown as ConfigStore,
    changed: (path) => changed.push(path),
    prepareSkillInclusion: () => undefined,
  });
  const snapshot = scanSmallTree(target);
  const operation = [
    {
      type: "rmtree" as const,
      path: target,
      treeEntries: snapshot.entries,
      treeRevision: snapshot.revision,
    },
  ];
  await review(operation, async () => {
    expect(existsSync(target)).toBe(true);
    rmSync(target, { recursive: true });
  });
  expect(message).toContain(join(target, "nested", "a.txt"));
  expect(options).toMatchObject({ properties: { decision: { enum: ["deny", "allow"] } } });
  expect(existsSync(target)).toBe(false);
  expect(changed).toEqual([target]);

  mkdirSync(join(target, "nested"), { recursive: true });
  writeFileSync(join(target, "nested", "a.txt"), "one");
  const next = scanSmallTree(target);
  race = true;
  await expect(
    review(
      [
        {
          type: "rmtree",
          path: target,
          treeEntries: next.entries,
          treeRevision: next.revision,
        },
      ],
      async () => {
        throw new Error("changed tree must not commit");
      },
    ),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(existsSync(join(target, "nested", "raced.txt"))).toBe(true);
  expect(changed).toEqual([target]);

  race = false;
  vanish = true;
  const vanished = scanSmallTree(target);
  await expect(
    review(
      [
        {
          type: "rmtree",
          path: target,
          treeEntries: vanished.entries,
          treeRevision: vanished.revision,
        },
      ],
      async () => {
        throw new Error("vanished tree must not commit");
      },
    ),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(existsSync(target)).toBe(false);
});

test("Auto reviews one captured workspace tree without asking the operator", async () => {
  const home = mkdtempSync(join(tmpdir(), "clarvis-authoring-auto-tree-"));
  temporary.push(home);
  const workspaceRoot = join(home, "workspace");
  const target = join(workspaceRoot, "probe");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "entry.txt"), "owned");
  const roots = configurationRoots({ home, workspaceRoot, globalDir: join(home, "global") });
  const services = createCapabilityServices();
  const ledger = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [{ id: "operator", source: "start", text: "Clean probe", execution_id: "run" }],
    },
  });
  services.provide(OPERATOR_AUTHORITY_PORT, ledger.reader);
  let reviews = 0;
  let allow = true;
  services.provide(
    JUDGE_PORT,
    judgePort(undefined, async (input, context) => {
      reviews++;
      const facts = (input.currentCase as unknown as { effects: GuardEffectFact[] }).effects;
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        id: "workspace.tree.delete",
        class: "destructive",
        inference: "bounded",
        attestation: "complete",
        constraints: { field_class: "bounded_tree", operation: "delete", bytes: 0 },
      });
      const transition =
        context.binding.kind === "compile_effects"
          ? await context.binding.validateAndInstall({
              version: 1,
              revision: ledger.reader.snapshot().revision,
              objectives: [],
              exclusions: [],
              grants: facts.map((fact, index) => ({
                id: `tree-${index}`,
                effect_id: fact.id,
                relation: "direct" as const,
                target_digests: [fact.target!.digest],
                constraints: fact.constraints,
                evidence_ids: ["operator"],
              })),
            })
          : context.binding.transition;
      if (transition === undefined || "rejected" in transition)
        return {
          kind: "failed",
          failureKind: "invalid_response",
          attempts: 1,
          elapsedMs: 0,
          cacheHit: false,
        };
      return {
        kind: "reviewed",
        receipt: {
          action: "decide_effects",
          decision: allow ? "allow" : "deny",
          relation: "direct",
          grant_ids: ["tree-0"],
          revision: transition.revision,
          transition_token: transition.transition_token,
        },
        attempts: 1,
        elapsedMs: 0,
        cacheHit: false,
      };
    }),
  );
  const ctx = {
    services,
    workspaceRoot,
    executionId: "run",
    env: loadEnv({}),
    request: { guard_mode: "auto" },
    requestParam: () => undefined,
    elicit: async () => {
      throw new Error("ordinary Auto cleanup must not ask the operator");
    },
  } as unknown as RunCapabilityContext;
  const review = createAuthoringMutationReview(ctx, {
    roots,
    store: { readSettings: () => ({ merged: {} }) } as unknown as ConfigStore,
    changed: () => {},
    prepareSkillInclusion: () => undefined,
  });
  const snapshot = scanSmallTree(target);
  await review(
    [
      {
        type: "rmtree",
        path: target,
        treeEntries: snapshot.entries,
        treeRevision: snapshot.revision,
      },
    ],
    async () => rmSync(target, { recursive: true }),
  );
  expect(reviews).toBe(1);
  expect(existsSync(target)).toBe(false);

  const other = join(workspaceRoot, "other");
  mkdirSync(other);
  writeFileSync(join(other, "entry.txt"), "keep");
  allow = false;
  const next = scanSmallTree(other);
  await expect(
    review(
      [{ type: "rmtree", path: other, treeEntries: next.entries, treeRevision: next.revision }],
      async () => rmSync(other, { recursive: true }),
    ),
  ).rejects.toMatchObject({ code: "denied" });
  expect(reviews).toBe(2);
  expect(existsSync(join(other, "entry.txt"))).toBe(true);
});

test("classified mutation rejects malformed and protected targets before changing files", async () => {
  const home = mkdtempSync(join(tmpdir(), "clarvis-authoring-policy-"));
  temporary.push(home);
  const workspaceRoot = join(home, "workspace");
  const globalDir = join(home, "global");
  mkdirSync(workspaceRoot);
  mkdirSync(globalDir);
  const roots = configurationRoots({ home, workspaceRoot, globalDir });
  const services = createCapabilityServices();
  const review = createAuthoringMutationReview(
    {
      services,
      workspaceRoot,
      env: loadEnv({}),
      request: { guard_mode: "on" },
      requestParam: () => undefined,
    } as unknown as RunCapabilityContext,
    {
      roots,
      store: { readSettings: () => ({ merged: {} }) } as unknown as ConfigStore,
      changed: () => {
        throw new Error("rejected mutation must not notify observers");
      },
      prepareSkillInclusion: () => undefined,
    },
  );
  const policy = {
    placement: "sandbox",
    workspaceAccess: "workspace-write",
    protectedRoots: [],
  } as unknown as ResolvedFilesystemPolicy;
  const tree = join(workspaceRoot, "tree");
  mkdirSync(tree);
  const snapshot = scanSmallTree(tree);
  const rmtree = {
    type: "rmtree" as const,
    path: tree,
    treeEntries: snapshot.entries,
    treeRevision: snapshot.revision,
  };
  const inertCommit = () => {
    throw new Error("rejected mutation must not commit");
  };
  await expect(review([rmtree, rmtree], inertCommit)).rejects.toMatchObject({
    code: "invalid_input",
  });
  await expect(review([{ ...rmtree, path: globalDir }], inertCommit)).rejects.toMatchObject({
    code: "denied",
  });
  const protectedTree = join(roots.workspace_agents, "skills", "agent-probe");
  mkdirSync(protectedTree, { recursive: true });
  const protectedSnapshot = scanSmallTree(protectedTree);
  await expect(
    review(
      [
        {
          type: "rmtree",
          path: protectedTree,
          treeEntries: protectedSnapshot.entries,
          treeRevision: protectedSnapshot.revision,
        },
      ],
      inertCommit,
    ),
  ).rejects.toMatchObject({ code: "denied" });
  await expect(review.commitClassified!([rmtree], policy)).rejects.toMatchObject({
    code: "denied",
  });

  const settings = join(roots.workspace_clarvis, "settings.json");
  const rmdir = { type: "rmdir" as const, path: protectedTree };
  const otherDirectory = join(roots.workspace_agents, "skills", "another-probe");
  mkdirSync(otherDirectory);
  await expect(review([rmdir, rmdir], inertCommit)).rejects.toMatchObject({
    code: "invalid_input",
  });
  await expect(
    review([rmdir, { type: "delete", path: settings }], inertCommit),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    review(
      [{ type: "rmdir", path: join(roots.workspace_agents, "skills", "missing") }],
      inertCommit,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    review(
      [
        { type: "create", path: settings, content: "{}" },
        { type: "delete", path: settings },
      ],
      inertCommit,
    ),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    review(
      [
        { type: "create", path: settings, content: "{}" },
        { type: "create", path: join(home, "outside.txt"), content: "x" },
      ],
      inertCommit,
    ),
  ).rejects.toMatchObject({ code: "denied" });
  await expect(
    review(
      [{ type: "create", path: join(roots.workspace_clarvis, "keys.json"), content: "{}" }],
      inertCommit,
    ),
  ).rejects.toMatchObject({ code: "denied" });
  await expect(review([rmdir], inertCommit)).rejects.toMatchObject({
    code: "approval_unavailable",
  });
  await expect(
    review.commitClassified!([rmdir], { ...policy, placement: "host" } as ResolvedFilesystemPolicy),
  ).rejects.toMatchObject({ code: "denied" });
  await expect(
    review.commitClassified!(
      [{ type: "delete", path: join(roots.workspace_clarvis, "keys.json") }],
      policy,
    ),
  ).rejects.toMatchObject({ code: "denied" });
  await expect(
    review.commitClassified!([{ type: "delete", path: join(home, "outside.txt") }], policy),
  ).rejects.toMatchObject({ code: "denied" });
  await expect(
    review.commitClassified!([{ type: "delete", path: "relative.txt" }], policy),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    review.commitClassified!([rmdir], { ...policy, protectedRoots: [protectedTree] }),
  ).rejects.toMatchObject({ code: "denied" });
  await expect(
    review.commitClassified!([rmdir, { type: "rmdir", path: otherDirectory }], policy),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(existsSync(tree)).toBe(true);
  expect(existsSync(protectedTree)).toBe(true);
  expect(existsSync(otherDirectory)).toBe(true);
});
