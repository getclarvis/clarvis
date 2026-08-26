import { describe, expect, it } from "bun:test";
import { ownerScopedKernelResolver } from "../../src/host/owner-scoping.ts";
import { createFakeRunHost } from "../helpers/fake-run-host.ts";

describe("ownerScopedKernelResolver", () => {
  it("binds the requested owner and preserves an authenticated principal", async () => {
    const host = createFakeRunHost(() => ({}));
    const seen: string[] = [];
    const kernel = {
      forOwner(owner: string) {
        seen.push(owner);
        return host;
      },
    };
    const principal = {
      clientId: "client-1",
      owner: "alice",
      role: "user",
      permissions: {
        agents: "*" as const,
        guardConfirmations: "deny" as const,
        mayImpersonateOwner: false,
      },
    };
    const resolve = ownerScopedKernelResolver(kernel);

    const resolved = await resolve({
      owner: "alice",
      principal,
      sessionId: "session-1",
      headers: new Headers(),
    });

    expect(seen).toEqual(["alice"]);
    expect(resolved.host).toBe(host);
    expect(resolved.owner).toBe("alice");
    expect(resolved.principal).toBe(principal);
  });

  it("omits principal when the connection is unauthenticated", async () => {
    const host = createFakeRunHost(() => ({}));
    const kernel = { forOwner: () => host };
    const resolve = ownerScopedKernelResolver(kernel);

    const resolved = await resolve({
      owner: "fixed",
      sessionId: "session-2",
      headers: new Headers(),
    });
    expect(resolved.host).toBe(host);
    expect(resolved.owner).toBe("fixed");
    expect(resolved.principal).toBeUndefined();
  });

  it("leases hosted owner scopes and forwards their idempotent release", async () => {
    const host = createFakeRunHost(() => ({}));
    const acquired: string[] = [];
    let releases = 0;
    const resolve = ownerScopedKernelResolver({
      forOwner() {
        throw new Error("leased hosts must not fall back to a pinned owner");
      },
      async acquireOwner(owner) {
        acquired.push(owner);
        return { value: host, release: () => void (releases += 1) };
      },
    });

    const resolved = await resolve({
      owner: "alice",
      sessionId: "session-3",
      headers: new Headers(),
    });

    expect(acquired).toEqual(["alice"]);
    expect(resolved.host).toBe(host);
    resolved.release?.();
    expect(releases).toBe(1);
  });
});
