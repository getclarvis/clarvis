import { describe, expect, it } from "bun:test";
import { buildTransport } from "@clarvis/mcp-client";

/**
 * What a stdio MCP child is allowed to see.
 *
 * The environment threaded through the kernel carries every resolved provider
 * API key, so "what does the child inherit" is a credential-exposure question,
 * not a convenience one. Nothing asserted it before, and the answer was "all of
 * it, for every server, whether or not the server asked".
 */
describe("buildTransport — the stdio child's environment", () => {
  const stdio = (env?: Record<string, string>) =>
    ({
      name: "s",
      transport: "stdio" as const,
      command: "true",
      ...(env !== undefined ? { env } : {}),
    }) as never;

  const envOf = (t: unknown): Record<string, string> =>
    (t as { _serverParams?: { env?: Record<string, string> } })._serverParams?.env ??
    (t as { parameters?: { env?: Record<string, string> } }).parameters?.env ??
    {};

  const HOST = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-should-never-reach-a-child",
    MY_COMPANY_LLM: "sk-named-by-a-provider-config",
    RANDOM_HOST_VAR: "incidental",
  };

  it("withholds credentials from a server that declares no env block", () => {
    const child = envOf(buildTransport(stdio(), HOST));
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.MY_COMPANY_LLM).toBeUndefined();
    expect(child.RANDOM_HOST_VAR).toBeUndefined();
  });

  it("withholds them from a server that declares an unrelated env block too", () => {
    // Declaring `env` used to *narrow* the child's environment while omitting it
    // widened to everything — the asymmetry meant the servers that asked for
    // least were trusted with most.
    const child = envOf(buildTransport(stdio({ SOME_FLAG: "1" }), HOST));
    expect(child.SOME_FLAG).toBe("1");
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("still passes a value the server explicitly interpolates", () => {
    // Naming a variable is the operator's decision to share it, so this must
    // keep working — it is the supported way to give one server one credential.
    const child = envOf(buildTransport(stdio({ TOKEN: "${MY_COMPANY_LLM}" }), HOST));
    expect(child.TOKEN).toBe("sk-named-by-a-provider-config");
  });

  it("gives every server the same fixed base, regardless of the caller's env object", () => {
    // The old code branched on `environment === process.env`, so the production
    // path and the default-argument path built different children from the same
    // config. Identity is not a policy.
    const injected = envOf(buildTransport(stdio(), HOST));
    const defaulted = envOf(buildTransport(stdio()));
    expect(Object.keys(injected).sort()).toEqual(Object.keys(defaulted).sort());
  });
});
