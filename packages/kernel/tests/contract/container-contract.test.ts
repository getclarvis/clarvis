import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { envSchema } from "@clarvis/capability";
import {
  projectContainerConfiguration,
  containerConfigurationDigest,
} from "../../src/config/container-projection.ts";
import {
  parseContainerInitialize,
  containerReadySchema,
  CONTAINER_MODEL_LEASE_MS,
  type ContainerInitialize,
} from "../../src/hosting/container-contract.ts";

function bootstrap(): ContainerInitialize {
  const configuration = projectContainerConfiguration({
    store: {
      readSettings: () => ({ merged: {}, operator_merged: {}, scopes: {}, sources: [] }),
      listAgents: () => [],
    },
    env: envSchema.parse({ CLARVIS_OWNER: "fixture" }),
    modelCatalog: [],
    sharedPrompt: "",
    contexts: [],
    memoryPolicy: "",
    workflowDefinitions: [],
  });
  return {
    generation: randomUUID(),
    owner: "fixture",
    workspaceIdentity: {
      project: { id: "project" },
      workspace: {
        id: "worktree",
        projectId: "project",
        label: "QA",
        kind: "primary",
        path: "/workspace",
      },
      namespace: "a".repeat(64),
    },
    runtime: {
      engine: "podman",
      hostPlatform: "linux",
      network: "none",
      baseDigest: `sha256:${"b".repeat(64)}`,
      baseAbi: "clarvis-linux-glibc-v1",
    },
    artifactDigest: `sha256:${"c".repeat(64)}`,
    configDigest: containerConfigurationDigest(configuration),
    configuration,
    modelLease: {
      leaseId: "d".repeat(64),
      models: [],
      expiresAt: 1000 + CONTAINER_MODEL_LEASE_MS,
      limits: {
        maxConcurrent: 2,
        maxQueued: 3,
        tokenCeiling: 100000,
        hostMaxRetries: 1,
        maxResponseBytes: 1000000,
        maxRetryAfterMs: 1000,
        maxTimeoutMs: 60000,
        defaultTimeoutMs: 30000,
      },
    },
  };
}

test("bootstrap admits the exact frozen identity without original configuration or credentials", () => {
  const input = bootstrap();
  expect(parseContainerInitialize(input, 1000)).toEqual(input);
  expect(parseContainerInitialize(input, 1000)).not.toBe(input);
  expect(
    parseContainerInitialize({ ...input, runtime: { ...input.runtime, network: "outbound" } }, 1000)
      .runtime.network,
  ).toBe("outbound");
});

test("bootstrap refuses alternate identity, paths, configuration, nested authority and stale leases", () => {
  const valid = bootstrap();
  for (const invalid of [
    { ...valid, argv: [] },
    { ...valid, generation: "not-uuid" },
    { ...valid, owner: "other" },
    { ...valid, owner: " " },
    { ...valid, configDigest: `sha256:${"e".repeat(64)}` },
    { ...valid, runtime: { ...valid.runtime, env: {} } },
    { ...valid, runtime: { ...valid.runtime, network: "internet" } },
    { ...valid, runtime: { ...valid.runtime, network: undefined } },
    { ...valid, runtime: { ...valid.runtime, baseDigest: "b".repeat(64) } },
    { ...valid, runtime: { ...valid.runtime, baseAbi: "future" } },
    {
      ...valid,
      workspaceIdentity: {
        ...valid.workspaceIdentity,
        workspace: { ...valid.workspaceIdentity.workspace, path: "/host" },
      },
    },
    { ...valid, workspaceIdentity: { ...valid.workspaceIdentity, project: { id: "other" } } },
    { ...valid, modelLease: { ...valid.modelLease, auth: "sentinel" } },
    {
      ...valid,
      modelLease: { ...valid.modelLease, models: [{ provider: "forged", model: "model" }] },
    },
    { ...valid, modelLease: { ...valid.modelLease, expiresAt: 1000 } },
    { ...valid, modelLease: { ...valid.modelLease, expiresAt: 1001 + CONTAINER_MODEL_LEASE_MS } },
    {
      ...valid,
      modelLease: {
        ...valid.modelLease,
        limits: { ...valid.modelLease.limits, defaultTimeoutMs: 60001 },
      },
    },
  ])
    expect(() => parseContainerInitialize(invalid, 1000)).toThrow();
});

test("bootstrap rejects oversized input before dispatch and never exposes projection data in diagnostics", () => {
  const valid = bootstrap();
  expect(() =>
    parseContainerInitialize({ ...valid, owner: "x".repeat(8 * 1024 * 1024) }, 1000),
  ).toThrow(expect.objectContaining({ code: "resource_exhausted" }));
  expect(() =>
    parseContainerInitialize({ ...valid, configuration: { secret: "credential-sentinel" } }, 1000),
  ).toThrow("Invalid Container bootstrap");
  let reads = 0;
  const input = Object.defineProperty({}, "configuration", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("credential-sentinel");
    },
  });
  expect(() => parseContainerInitialize(input, 1000)).toThrow("Invalid Container bootstrap");
  expect(reads).toBe(0);
});

test("bootstrap keeps its 8 MiB envelope independent of the 4 MiB configuration ceiling", () => {
  const input = structuredClone(bootstrap());
  input.owner = "o".repeat(1024 * 1024);
  input.configuration.loopPolicy = {
    ...input.configuration.loopPolicy,
    CLARVIS_OWNER: input.owner,
  };
  input.configuration.contexts = [{ scope: "workspace", content: "p".repeat(2800000) }];
  input.configDigest = containerConfigurationDigest(input.configuration);
  expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(4 * 1024 * 1024);
  expect(parseContainerInitialize(input, 1000).owner).toBe(input.owner);
  input.configuration.contexts = [{ scope: "workspace", content: "p".repeat(4 * 1024 * 1024) }];
  expect(() => parseContainerInitialize(input, 1000)).toThrow();
});

test("ready has only the admitted revisions and exact digest identity", () => {
  const input = bootstrap();
  const ready = {
    ready: true,
    generation: input.generation,
    artifactDigest: input.artifactDigest,
    configDigest: input.configDigest,
    kernelWireVersion: 10,
    brokerVersion: 1,
  };
  expect(containerReadySchema.safeParse(ready).success).toBe(true);
  expect(containerReadySchema.safeParse({ ...ready, kernelWireVersion: 9 }).success).toBe(false);
  expect(containerReadySchema.safeParse({ ...ready, runtime_protocol_revision: 14 }).success).toBe(
    false,
  );
});
