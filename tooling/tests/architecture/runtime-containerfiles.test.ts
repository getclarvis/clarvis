import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  RUNTIME_BASE_IMAGE,
  RUNTIME_BUILD_IMAGE,
  RUNTIME_MISE_SHA256_AMD64,
  RUNTIME_MISE_SHA256_ARM64,
  RUNTIME_MISE_VERSION,
  RUNTIME_PROTOCOL_REVISION,
} from "../../runtime/build-image.ts";
import { RUNTIME_PROTOCOL_REVISION as GUEST_PROTOCOL_REVISION } from "../../../packages/kernel/src/runtime/protocol-revision.ts";

const root = resolve(import.meta.dir, "../../..");
const production = readFileSync(resolve(root, "Containerfile.runtime"), "utf8");
const development = readFileSync(resolve(root, "Containerfile.runtime-development"), "utf8");
const guestEntry = readFileSync(resolve(root, "tooling/runtime/guest-entry.ts"), "utf8");
const product = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  workspaces: string[];
};

test("production runtime image consumes only a released carrier", () => {
  expect(production).toContain(`ARG BASE_IMAGE=${RUNTIME_BASE_IMAGE}`);
  expect(production).toContain("FROM ${RUNTIME_ARTIFACT} AS runtime");
  expect(production).toContain("COPY --from=runtime --chmod=0555 /clarvis-runtime");
  expect(production).toContain("COPY --from=runtime /licenses /usr/share/licenses/clarvis");
  expect(production).not.toContain("COPY packages");
  expect(production).not.toContain("bun install");
  expect(production).not.toContain("bun build");
  expect(RUNTIME_BASE_IMAGE).toStartWith("docker.io/library/debian:bookworm-slim@sha256:");
  expect(production).toContain("git ca-certificates");
  const miseStage = production.indexOf("FROM ${BASE_IMAGE}");
  const finalStage = production.indexOf("FROM ${BASE_IMAGE}", miseStage + 1);
  const finalInstall = production.slice(
    production.indexOf("RUN apt-get update", finalStage),
    production.indexOf("COPY --from=mise"),
  );
  for (const packageName of [
    "curl",
    "xz-utils",
    "nodejs",
    "npm",
    "python3",
    "build-essential",
    "cargo",
  ]) {
    expect(finalInstall).not.toMatch(new RegExp(`\\b${packageName}\\b`, "u"));
  }
  expect(production).not.toContain("node --version");
  expect(production).not.toContain("npm --version");
  expect(production).toContain(`ARG MISE_VERSION=${RUNTIME_MISE_VERSION}`);
  expect(production).toContain(`ARG MISE_SHA256_AMD64=${RUNTIME_MISE_SHA256_AMD64}`);
  expect(production).toContain(`ARG MISE_SHA256_ARM64=${RUNTIME_MISE_SHA256_ARM64}`);
  expect(production).toContain("dpkg --print-architecture");
  expect(production).toContain("sha256sum -c -");
  expect(production).toContain("COPY --from=mise --chmod=0555 /out/mise");
  expect(production).toContain("COPY --from=mise /out/LICENSE");
  expect(production).toContain("MISE_DATA_DIR=/mise");
  expect(production).toContain("MISE_QUIET=1");
  expect(production).toContain("PATH=/mise/shims:${PATH}");
  expect(production).toContain("mise --version");
});

test("source compilation is confined to the explicit development carrier", () => {
  expect(development).toContain(`ARG BUILD_IMAGE=${RUNTIME_BUILD_IMAGE}`);
  for (const workspace of product.workspaces) {
    expect(development).toContain(`COPY ${workspace}/package.json`);
  }
  expect(development).toContain("COPY packages ./packages");
  expect(development).toContain(
    "COPY tooling/runtime/guest-entry.ts ./tooling/runtime/guest-entry.ts",
  );
  expect(development).toContain("bun install --frozen-lockfile");
  expect(development).toContain("bun build tooling/runtime/guest-entry.ts --compile");
  expect(development).toContain("find node_modules -type f");
  expect(development).toContain("COPY --from=build /out/npm-licenses/node_modules /licenses/npm");
  for (const license of [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "third-party/bun/LICENSE.md",
    "third-party/models.dev/LICENSE",
    "third-party/vercel-ai-sdk/LICENSE",
  ]) {
    expect(development).toContain(`COPY ${license} /licenses/`);
  }
});

test("the guest build entry installs its bundled validator before entering the worker", () => {
  for (const dependency of ["ajv", "ajv-formats"]) {
    expect(guestEntry).toContain(`from "${dependency}"`);
  }
  expect(guestEntry).toContain(
    "installBundledAjvModules({ Ajv, addFormats: formatsModule.default.default });",
  );
  expect(guestEntry).toContain('from "../../packages/kernel/src/runtime/guest-main.ts"');
  expect(guestEntry).toContain("if (import.meta.main) void runGuestEntry().catch");
  expect(guestEntry).toContain('from "../../packages/kernel/src/runtime/preview-relay.ts"');
});

test("tool runtime dependencies are statically reachable by the standalone compiler", () => {
  const sources = [
    "packages/tools/src/core.ts",
    "packages/tools/src/lib/files.ts",
    "packages/tools/src/lib/ignore.ts",
  ].map((path) => readFileSync(resolve(root, path), "utf8"));
  expect(sources.join("\n")).not.toContain("createRequire");
  expect(sources[0]).toContain('from "ajv"');
  expect(sources[1]).toContain('from "picomatch"');
  expect(sources[2]).toContain('from "ignore"');
});

test("carrier and final image advertise the guest protocol owned by source", () => {
  expect(RUNTIME_PROTOCOL_REVISION).toBe(GUEST_PROTOCOL_REVISION);
  for (const source of [production, development]) {
    expect(source).toContain('org.opencontainers.image.licenses="MIT"');
    expect(source).toContain(`io.clarvis.runtime.protocol="${RUNTIME_PROTOCOL_REVISION}"`);
  }
  expect(production).toContain('ENTRYPOINT ["/usr/local/bin/clarvis-runtime"]');
});
