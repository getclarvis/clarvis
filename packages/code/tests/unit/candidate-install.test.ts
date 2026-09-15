import { expect, test } from "bun:test";
import { candidateJson, selectCandidateRelease } from "../../tooling/candidate-install.ts";
import { parseRuntimeCandidate } from "../../src/adapters/runtime-candidate.ts";

const tag = "v1.2.3-rc.4";
const revision = "a".repeat(40);
const target = (name: "linux-x64" | "linux-arm64", hash: string) =>
  ({
    base: {
      image: "ghcr.io/getclarvis/clarvis-base",
      digest: `sha256:${hash.repeat(64)}`,
      abi: "clarvis-linux-glibc-v1",
    },
    artifact: {
      asset: `clarvis-kernel-${name}.tar.gz`,
      sha256: (hash === "b" ? "d" : "e").repeat(64),
      size: 1024,
    },
    kernel_wire_version: 11,
    broker_version: 1,
    channel_version: 1,
  }) as const;
const runtime = {
  schema_version: 2,
  version: "1.2.3",
  source_revision: revision,
  targets: { "linux-x64": target("linux-x64", "b"), "linux-arm64": target("linux-arm64", "c") },
} as const;
const candidate = {
  schema: 1,
  channel: "candidate",
  installation: "source-v1",
  tag,
  version: "1.2.3",
  source_revision: revision,
  repository: "getclarvis/clarvis",
  kernel_wire_version: 11,
  broker_version: 1,
  channel_version: 1,
  targets: ["linux-x64", "linux-arm64"],
  runtime,
} as const;

test("candidate identity embeds the schema-2 base/artifact map without prefetching an image", () => {
  expect(parseRuntimeCandidate(candidate, tag)).toEqual(candidate);
  for (const invalid of [
    { ...candidate, runtime: { ...runtime, schema_version: 1 } },
    { ...candidate, broker_version: 2 },
    { ...candidate, targets: ["linux-x64"] },
  ])
    expect(() => parseRuntimeCandidate(invalid, tag)).toThrow();
});

test("candidate selection requires an exact published sidecar and compares RC numbers numerically", () => {
  const release = (name: string, sidecar = true) => ({
    tag_name: name,
    draft: false,
    prerelease: true,
    assets: sidecar ? [{ name: "runtime-candidate.json" }] : [],
  });
  expect(selectCandidateRelease([release("v1.2.3-rc.2"), release(tag)])).toBe(tag);
  expect(() => selectCandidateRelease([release(tag, false)])).toThrow();
});

test("candidate metadata bounds bodies and refuses a foreign final origin", async () => {
  const foreign = new Response("{}");
  Object.defineProperty(foreign, "url", { value: "https://invalid.example/manifest" });
  await expect(
    candidateJson("https://github.com/getclarvis/clarvis", async () => foreign),
  ).rejects.toThrow("outside GitHub");
  await expect(
    candidateJson(
      "https://github.com/getclarvis/clarvis",
      async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ),
  ).rejects.toThrow("size limit");
});
