import { describe, it, expect } from "bun:test";
import { BUILT_IN_ROLES, parseAuthConfig } from "../../src/auth/auth-config.ts";
import { DEFAULT_ENTRY_AGENT } from "@clarvis/kernel/config";
import { mayRunAgent, resolvePrincipal } from "../../src/auth/principals.ts";
import { cheapHash } from "../helpers/auth.ts";

const DEFAULTS = { publicUrl: undefined, mcpPath: "/mcp" };
const HASH = cheapHash("a-secret");

/** A minimal valid document, with the given fields overridden. */
function document(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    issuer: "https://clarvis.test",
    resource: "https://clarvis.test/mcp",
    clients: [{ client_id: "svc", secret_hash: HASH, owner: "acme", role: "user" }],
    ...over,
  };
}

describe("parseAuthConfig", () => {
  it("resolves issuer and resource from the public URL when the file omits them", () => {
    const config = parseAuthConfig(
      { version: 1, clients: [{ client_id: "svc", secret_hash: HASH, owner: "acme" }] },
      { publicUrl: "https://clarvis.example.com/", mcpPath: "/mcp" },
    );
    expect(config.issuer).toBe("https://clarvis.example.com");
    expect(config.resource).toBe("https://clarvis.example.com/mcp");
  });

  it("refuses a file that names no identity and has no public URL to borrow one from", () => {
    expect(() =>
      parseAuthConfig(
        { version: 1, clients: [{ client_id: "svc", secret_hash: HASH, owner: "acme" }] },
        DEFAULTS,
      ),
    ).toThrow(/cannot determine this server's identity/);
  });

  it("refuses an empty client table rather than reading it as 'allow everyone'", () => {
    expect(() => parseAuthConfig(document({ clients: [] }), DEFAULTS)).toThrow(
      /at least one client/,
    );
  });

  it("refuses a plaintext secret parked in secret_hash", () => {
    expect(() =>
      parseAuthConfig(
        document({ clients: [{ client_id: "svc", secret_hash: "hunter2", owner: "acme" }] }),
        DEFAULTS,
      ),
    ).toThrow(/sha256:<base64url>/);
  });

  it("refuses unknown fields at every auth boundary", () => {
    expect(() => parseAuthConfig(document({ token_ttl: 60 }), DEFAULTS)).toThrow(
      /Unrecognized key.*token_ttl/,
    );
    expect(() =>
      parseAuthConfig(
        document({
          clients: [{ client_id: "svc", secret_hash: HASH, owner: "acme", roles: "admin" }],
        }),
        DEFAULTS,
      ),
    ).toThrow(/Unrecognized key.*roles/);
    expect(() =>
      parseAuthConfig(document({ roles: { user: { may_impersonate: true } } }), DEFAULTS),
    ).toThrow(/Unrecognized key.*may_impersonate/);
  });

  it("refuses a digest of the right shape but the wrong width", () => {
    expect(() =>
      parseAuthConfig(
        document({
          clients: [{ client_id: "svc", secret_hash: "sha256:dG9vLXNob3J0", owner: "acme" }],
        }),
        DEFAULTS,
      ),
    ).toThrow(/sha256:<base64url>/);
  });

  it("refuses a duplicate client id and an undeclared role", () => {
    expect(() =>
      parseAuthConfig(
        document({
          clients: [
            { client_id: "svc", secret_hash: HASH, owner: "a" },
            { client_id: "svc", secret_hash: HASH, owner: "b" },
          ],
        }),
        DEFAULTS,
      ),
    ).toThrow(/duplicate client_id 'svc'/);

    expect(() =>
      parseAuthConfig(
        document({
          clients: [{ client_id: "svc", secret_hash: HASH, owner: "a", role: "ghost" }],
        }),
        DEFAULTS,
      ),
    ).toThrow(/undeclared role 'ghost'/);
  });

  it("refuses an owner id that the per-request resolver would reject", () => {
    expect(() =>
      parseAuthConfig(
        document({ clients: [{ client_id: "svc", secret_hash: HASH, owner: "../escape" }] }),
        DEFAULTS,
      ),
    ).toThrow(/owner must match/);
  });

  it("ships admin and user without a roles block, and lets a declaration narrow one", () => {
    const config = parseAuthConfig(document(), DEFAULTS);
    expect(config.roles.admin).toEqual(BUILT_IN_ROLES.admin!);
    expect(config.roles.user).toEqual(BUILT_IN_ROLES.user!);

    const narrowed = parseAuthConfig(
      document({ roles: { admin: { agents: ["triage"], max_runs: 2 } } }),
      DEFAULTS,
    );
    expect(narrowed.roles.admin).toEqual({
      agents: ["triage"],
      guardConfirmations: "relay",
      mayImpersonateOwner: true,
      maxRuns: 2,
    });
  });

  it("starts a role nobody declared a base for from the user posture", () => {
    const config = parseAuthConfig(
      document({
        roles: { service: { agents: ["support"] } },
        clients: [{ client_id: "svc", secret_hash: HASH, owner: "acme", role: "service" }],
      }),
      DEFAULTS,
    );
    expect(config.roles.service).toEqual({
      agents: ["support"],
      guardConfirmations: "deny",
      mayImpersonateOwner: false,
    });
  });
});

describe("resolvePrincipal", () => {
  it("resolves an enrolled client and refuses one that is unknown or disabled", async () => {
    const config = parseAuthConfig(
      document({
        clients: [
          { client_id: "svc", secret_hash: cheapHash("s"), owner: "acme", role: "admin" },
          {
            client_id: "old",
            secret_hash: cheapHash("s"),
            owner: "acme",
            disabled: true,
          },
        ],
      }),
      DEFAULTS,
    );

    const found = resolvePrincipal(config, "svc");
    expect(found).toMatchObject({ ok: true, principal: { owner: "acme", role: "admin" } });
    expect(resolvePrincipal(config, "ghost")).toEqual({ ok: false, reason: "unknown_client" });
    expect(resolvePrincipal(config, "old")).toEqual({ ok: false, reason: "disabled_client" });
  });
});

describe("mayRunAgent", () => {
  const principal = (agents: "*" | string[]) => ({
    clientId: "svc",
    owner: "acme",
    role: "service",
    permissions: { agents, guardConfirmations: "deny" as const, mayImpersonateOwner: false },
  });

  it("lets an unrestricted role omit the agent entirely", () => {
    expect(mayRunAgent(principal("*"), undefined)).toBe(true);
    expect(mayRunAgent(principal("*"), "anything")).toBe(true);
  });

  it("requires a named agent from a restricted role, so the allowlist is not decorative", () => {
    expect(mayRunAgent(principal(["support"]), undefined)).toBe(false);
    expect(mayRunAgent(principal(["support"]), "support")).toBe(true);
    expect(mayRunAgent(principal(["support"]), "root")).toBe(false);
  });

  /**
   * The kernel now resolves an omitted `agent` to the shipped entry agent, so
   * "omitted" is no longer the same as "unresolvable". The refusal above has to
   * hold on its own: a restricted role must not reach an agent nobody put on
   * its allowlist just by leaving the argument out.
   */
  it("does not admit the shipped entry agent through an omitted argument", () => {
    expect(mayRunAgent(principal([DEFAULT_ENTRY_AGENT]), undefined)).toBe(false);
    expect(mayRunAgent(principal(["support"]), DEFAULT_ENTRY_AGENT)).toBe(false);
  });
});
