import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "@clarvis/capability";
import { createFileConfigStore } from "../../src/config/file-config-store.ts";
import {
  localHostPolicyIdentity,
  localKernelPolicyIdentity,
} from "../../src/hosting/policy-identity.ts";

it("compares resolved operator policy without secret, owner or log environment material", () => {
  const first = localKernelPolicyIdentity(
    loadEnv({
      CLARVIS_AGENT_TOOLS_ENABLED: "false",
      CLARVIS_DEFAULT_ELICIT_WAIT_MS: "1234",
      ANTHROPIC_API_KEY: "first-secret",
      CLARVIS_OWNER: "first-owner",
      CLARVIS_LOG: "private=debug",
    }),
  );
  expect(
    localKernelPolicyIdentity(
      loadEnv({
        CLARVIS_AGENT_TOOLS_ENABLED: "0",
        CLARVIS_DEFAULT_ELICIT_WAIT_MS: "01234",
        ANTHROPIC_API_KEY: "second-secret",
        CLARVIS_OWNER: "second-owner",
        CLARVIS_LOG_LEVEL: "silent",
      }),
    ),
  ).toBe(first);
});

it.each([
  { CLARVIS_AGENT_TOOLS_ENABLED: "0" },
  { CLARVIS_AGENT_TOOLS_MAX_GRANT: "read" },
  { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
  { CLARVIS_DEFAULT_ELICIT_WAIT_MS: "1234" },
  { CLARVIS_RETRY_CEILING: "0", CLARVIS_DEFAULT_MAX_RETRIES: "0" },
  { CLARVIS_MAX_CONCURRENT_MODEL_CALLS: "1" },
])("refuses both widened and narrowed execution policy %j", (environment) => {
  expect(localKernelPolicyIdentity(loadEnv(environment))).not.toBe(
    localKernelPolicyIdentity(loadEnv({})),
  );
});

it("binds effective Sandbox settings to a host generation without hashing credential values", () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-policy-identity-"));
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  mkdirSync(workspaceRoot);
  mkdirSync(globalDir);
  const env = loadEnv({});
  const identity = (secret: string) =>
    localHostPolicyIdentity({
      env,
      workspaceRoot,
      globalDir,
      environment: { SECRET_API_KEY: secret },
    });
  try {
    const host = identity("first-secret");
    writeFileSync(
      join(globalDir, "settings.json"),
      JSON.stringify({
        sandbox: {
          type: "native",
          enabled: true,
          filesystem: "workspace-read-only",
          network: "none",
          toolchains: { mode: "manual" },
        },
      }),
    );
    const changed = identity("first-secret");
    expect(changed).not.toBe(host);
    expect(identity("second-secret")).toBe(changed);
    expect(changed).not.toContain("secret");
    const store = createFileConfigStore({ workspaceRoot, globalDir });
    store.writeSettings("workspace", {
      sandbox: {
        type: "native",
        enabled: false,
        filesystem: "workspace-write",
        network: "host",
      },
    });
    expect(identity("second-secret")).toBe(changed);
    mkdirSync(join(workspaceRoot, "vendor", "sdk"), { recursive: true });
    store.writeSettings("workspace", {
      sandbox: { type: "native", toolchains: { extra_paths: ["./vendor/sdk"] } },
    });
    expect(identity("second-secret")).not.toBe(changed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
