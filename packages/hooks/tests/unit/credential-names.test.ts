import { describe, expect, it } from "bun:test";
import { runCredentialNames } from "../../src/capability.ts";
import { context, request } from "../helpers/capability.ts";

describe("runCredentialNames", () => {
  const ctx = (over: Parameters<typeof request>[0] = {}) => context({ request: request(over) });

  it("denies a provider's declared key variable", () => {
    const names = runCredentialNames(
      ctx({
        providers: [{ name: "anthropic", kind: "anthropic", api_key_env: "ANTHROPIC_API_KEY" }],
      }),
      [],
    );
    expect(names).toContain("ANTHROPIC_API_KEY");
  });

  it("denies the variables an MCP server interpolates into env and headers", () => {
    const names = runCredentialNames(
      ctx({
        servers: [
          {
            name: "github",
            transport: "stdio",
            env: { TOKEN: "${GH_PAT}" },
            headers: { Authorization: "Bearer ${GH_OTHER}" },
          },
        ],
      }),
      [],
    );
    expect(names).toContain("GH_PAT");
    expect(names).toContain("GH_OTHER");
  });

  it("denies a host-managed key the run's own request never mentions", () => {
    const names = runCredentialNames(ctx(), ["LINEAR_PAT"]);
    expect(names).toContain("LINEAR_PAT");
  });

  it("keeps host-managed names even when the run narrowed every server away", () => {
    const names = runCredentialNames(ctx({ servers: [] }), ["LINEAR_PAT", "NOTION_PAT"]);
    expect(names).toEqual(expect.arrayContaining(["LINEAR_PAT", "NOTION_PAT"]));
  });

  it("T9: denies the variables a provider interpolates into its own headers", () => {
    const names = runCredentialNames(
      ctx({
        providers: [
          {
            name: "router",
            kind: "openai-compatible",
            api_key_env: "ROUTER_KEY",
            headers: { "X-Partner": "${PARTNER_TOKEN}", Authorization: "Bearer ${ROUTER_ALT}" },
          },
        ],
      }),
      [],
    );
    expect(names).toContain("PARTNER_TOKEN");
    expect(names).toContain("ROUTER_ALT");
  });

  it("T9: denies the variables a MODEL interpolates into its headers", () => {
    // `models` is a record, not an array: a `for…of` over it iterates nothing
    // and throws nothing, and the omission is invisible in production because a
    // hook that reads the leaked token succeeds.
    const names = runCredentialNames(
      ctx({
        providers: [
          {
            name: "router",
            kind: "openai-compatible",
            headers: { "X-Partner": "${PROVIDER_LEVEL}" },
            models: {
              "deepseek/v4": {
                context_window_tokens: 128_000,
                headers: { "X-Partner": "${MODEL_LEVEL}" },
              },
              "other/model": {
                context_window_tokens: 128_000,
                headers: { "X-Other": "${SECOND_MODEL}" },
              },
            },
          },
        ],
      }),
      [],
    );
    expect(names).toEqual(
      expect.arrayContaining(["PROVIDER_LEVEL", "MODEL_LEVEL", "SECOND_MODEL"]),
    );
  });

  it("tolerates a provider with no headers and no models", () => {
    expect(
      runCredentialNames(ctx({ providers: [{ name: "anthropic", kind: "anthropic" }] }), []),
    ).toEqual([]);
  });
});
