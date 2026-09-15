import { expect, it } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import { localKernelPolicyIdentity } from "../../src/hosting/policy-identity.ts";

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
  { CLARVIS_AGENT_TOOLS_CONFINE: "0" },
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
