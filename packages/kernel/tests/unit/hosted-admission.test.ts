import { describe, expect, test } from "bun:test";
import { createHostedAdmission } from "../../src/hosting/admission.ts";

describe("hosted admission and interactive authority", () => {
  test("keeps conversation control between stages and requires explicit takeover", () => {
    const admission = createHostedAdmission({ revokeInteractiveScope: () => {} });
    const first = admission.connect("operator");
    const second = admission.connect("operator");
    const observer = admission.connect("observer");
    const authority = admission.claimConversation(first, "session");
    expect(admission.claimConversation(first, "session")).toBe(authority);
    expect(() => admission.assertConversation({ ...authority })).toThrow("retired");
    expect(() => admission.claimConversation({ ...first }, "session")).toThrow("authority");
    expect(() => admission.claimConversation(observer, "session", true)).toThrow("authority");
    expect(() => admission.claimConversation(second, "session")).toThrow("explicitly");
    expect(() => admission.reserve(second, "session", "run", "intruder")).toThrow("takeover");
    const run = admission.reserve(first, "session", "run", "first");
    admission.release(run);
    expect(() => admission.assertConversation(authority)).not.toThrow();
    const next = admission.claimConversation(second, "session", true);
    expect(authority.signal.aborted).toBe(true);
    admission.releaseConversation(authority);
    expect(() => admission.assertConversation(next)).not.toThrow();
    const work = admission.reserve(second, "session", "run", "next");
    admission.disconnect(second);
    expect(next.signal.aborted).toBe(true);
    expect(admission.occupied("session")).toBe(true);
    admission.release(work);
    const resumed = admission.claimConversation(first, "session");
    expect(resumed).not.toBe(authority);
    expect(() => admission.assertConversation(authority)).toThrow("retired");
    admission.closeSession(first, "session");
    expect(resumed.signal.aborted).toBe(true);
  });

  test("physical takeover retires old goal control without releasing occupancy", () => {
    const admission = createHostedAdmission({ revokeInteractiveScope: () => {} });
    const first = admission.connect("operator");
    const second = admission.connect("operator");
    const old = admission.claimConversation(first, "session");
    const run = admission.reserve(first, "session", "run", "execution");
    expect(() => admission.claimConversation(second, "session", true)).toThrow(
      "execution controller",
    );
    admission.acquire(second, run, true);
    const current = admission.claimConversation(second, "session");
    expect(old.signal.aborted).toBe(true);
    expect(current.signal.aborted).toBe(false);
    expect(admission.occupied("session")).toBe(true);
    admission.closeSession(second, "session");
    expect(current.signal.aborted).toBe(true);
    expect(admission.occupied("session")).toBe(true);
  });

  test("continues once through the real controller only after physical release", () => {
    const admission = createHostedAdmission({ revokeInteractiveScope: () => {} });
    const peer = admission.connect("operator");
    const run = admission.reserve(peer, "session", "run", "first");
    const authority = admission.captureContinuation(peer, run);
    expect(admission.captureContinuation(peer, run)).toBe(authority);
    expect(() => admission.reserveContinuation(authority, "early")).toThrow("physical work");
    expect(() => admission.reserveContinuation({ ...authority }, "forged")).toThrow("retired");
    const scope = admission.control(run).interactiveScope;
    admission.release(run);
    const next = admission.reserveContinuation(authority, "second");
    expect(admission.control(next)).toMatchObject({ peerId: peer.id, interactiveScope: scope });
    expect(authority.signal.aborted).toBe(true);
    expect(() => admission.reserveContinuation(authority, "replay")).toThrow("retired");
    admission.release(next);
  });

  test.each(["disconnect", "close", "takeover", "human", "retire"] as const)(
    "%s revokes continuation without granting release or affecting another conversation",
    (action) => {
      const admission = createHostedAdmission({ revokeInteractiveScope: () => {} });
      const first = admission.connect("operator");
      const second = admission.connect("operator");
      const run = admission.reserve(first, "session", "run", "first");
      const other = admission.reserve(second, "other", "run", "other-first");
      const authority = admission.captureContinuation(first, run);
      const unrelated = admission.captureContinuation(second, other);
      if (action === "disconnect") admission.disconnect(first);
      else if (action === "close") admission.closeSession(first, "session");
      else if (action === "takeover") admission.acquire(second, run, true);
      else if (action === "retire") admission.retireContinuation(authority);
      else {
        admission.release(run);
        admission.reserve(first, "session", "run", "human-turn");
      }
      expect(authority.signal.aborted).toBe(true);
      expect(unrelated.signal.aborted).toBe(false);
      expect(admission.occupied("session")).toBe(true);
      expect(() => admission.reserveContinuation(authority, "late")).toThrow("retired");
    },
  );

  test("retirement of an old continuation cannot revoke its successor", () => {
    const admission = createHostedAdmission({ revokeInteractiveScope: () => {} });
    const peer = admission.connect("operator");
    const run = admission.reserve(peer, "session", "run", "first");
    const previous = admission.captureContinuation(peer, run);
    admission.release(run);
    const next = admission.reserveContinuation(previous, "second");
    const current = admission.captureContinuation(peer, next);
    admission.retireContinuation(previous);
    expect(current.signal.aborted).toBe(false);
    expect(() => admission.captureContinuation({ ...peer }, next)).toThrow("authority");
    const observer = admission.connect("observer");
    expect(() => admission.captureContinuation(observer, next)).toThrow("authority");
  });

  test("revocation failure cannot leave a disconnected peer or its controls usable", () => {
    const attempts: string[] = [];
    const admission = createHostedAdmission({
      revokeInteractiveScope(scope) {
        attempts.push(scope);
        throw new Error("revoker failed");
      },
    });
    const peer = admission.connect("operator");
    const first = admission.reserve(peer, "first", "run", "one");
    const second = admission.reserve(peer, "second", "run", "two");
    expect(() => admission.disconnect(peer)).toThrow("retirement failed");
    expect(attempts.length).toBe(2);
    expect(admission.control(first).peerId).toBeUndefined();
    expect(admission.control(second).peerId).toBeUndefined();
    expect(admission.stats()).toMatchObject({ connections: 0, consent_scopes: 0, runs: 2 });
    expect(() => admission.assertControl(peer, first, 1)).toThrow("retired");
  });

  test("reserves synchronously and retains occupancy through disconnect until physical release", () => {
    const revoked: string[] = [];
    const admission = createHostedAdmission({
      revokeInteractiveScope: (scope) => revoked.push(scope),
    });
    const first = admission.connect("operator");
    const run = admission.reserve(first, "conversation", "run", "execution");
    const control = admission.control(run);
    expect(() => admission.reserve(first, "conversation", "run", "duplicate")).toThrow(
      "physical work",
    );
    expect(admission.disconnect(first)).toEqual([run]);
    expect(revoked).toEqual([control.interactiveScope!]);
    const second = admission.connect("operator");
    expect(() => admission.reserve(second, "conversation", "shell")).toThrow("physical work");
    expect(admission.control(run).peerId).toBeUndefined();
    expect(admission.occupied("conversation")).toBe(true);
    admission.release(run);
    admission.release(run);
    expect(admission.reserve(second, "conversation", "shell").kind).toBe("shell");
    expect(admission.stats()).toMatchObject({ runs: 0, activities: 1 });
  });

  test("observers and forged peers cannot acquire execution or control authority", () => {
    const admission = createHostedAdmission({ revokeInteractiveScope: () => {} });
    const operator = admission.connect("operator");
    const observer = admission.connect("observer");
    const run = admission.reserve(operator, "conversation", "run", "execution");
    expect(() => admission.reserve(observer, "second", "run", "other")).toThrow("authority");
    expect(() => admission.acquire(observer, run, true)).toThrow("authority");
    expect(() => admission.assertControl({ ...operator }, run, 1)).toThrow("authority");
    admission.disconnect(operator);
    expect(() => admission.acquire(operator, run)).toThrow("retired");
  });

  test("takeover fences stale controls and revokes only that conversation's consent", () => {
    const revoked: string[] = [];
    const admission = createHostedAdmission({
      revokeInteractiveScope: (scope) => revoked.push(scope),
    });
    const first = admission.connect("operator");
    const second = admission.connect("operator");
    const run = admission.reserve(first, "one", "run", "execution-one");
    const unrelated = admission.reserve(first, "two", "run", "execution-two");
    const old = admission.control(run);
    const other = admission.control(unrelated);
    expect(() => admission.acquire(second, run)).toThrow("another TUI");
    const current = admission.acquire(second, run, true);
    expect(current.epoch).toBeGreaterThan(old.epoch);
    expect(current.interactiveScope).not.toBe(old.interactiveScope);
    expect(revoked).toEqual([old.interactiveScope!]);
    expect(() => admission.assertControl(first, run, old.epoch)).toThrow("control changed");
    admission.assertControl(second, run, current.epoch);
    admission.assertControl(first, unrelated, other.epoch);
    expect(admission.acquire(second, run)).toEqual(current);
  });

  test("consent survives turns only within the same live conversation instance", () => {
    const revoked: string[] = [];
    const admission = createHostedAdmission({
      revokeInteractiveScope: (scope) => revoked.push(scope),
    });
    const peer = admission.connect("operator");
    const first = admission.reserve(peer, "conversation", "run", "one");
    const initialScope = admission.control(first).interactiveScope;
    admission.release(first);
    const second = admission.reserve(peer, "conversation", "run", "two");
    expect(admission.control(second).interactiveScope).toBe(initialScope);
    admission.release(second);
    admission.closeSession(peer, "conversation");
    const resumed = admission.reserve(peer, "conversation", "run", "three");
    expect(admission.control(resumed).interactiveScope).not.toBe(initialScope);
    expect(revoked).toEqual([initialScope!]);
  });

  test("limits main runs, local activities, clients and retained conversation scopes independently", () => {
    const admission = createHostedAdmission({
      maxConnections: 2,
      maxRuns: 1,
      maxActivities: 1,
      maxSessionScopes: 2,
      revokeInteractiveScope: () => {},
    });
    const peer = admission.connect("operator");
    admission.connect("observer");
    expect(() => admission.connect("operator")).toThrow("client limit");
    const run = admission.reserve(peer, "one", "run", "execution");
    expect(() => admission.reserve(peer, "two", "run", "other")).toThrow("activity limit");
    const shell = admission.reserve(peer, "two", "shell");
    expect(() => admission.reserve(peer, "three", "compaction")).toThrow("activity limit");
    admission.release(run);
    admission.release(shell);
    expect(() => admission.reserve(peer, "three", "run", "new")).toThrow(
      "open interactive conversations",
    );
    admission.closeSession(peer, "one");
    expect(admission.reserve(peer, "three", "run", "new").sessionId).toBe("three");
    expect(admission.stats()).toEqual({
      connections: 2,
      runs: 1,
      activities: 0,
      consent_scopes: 2,
    });
  });

  test("invalid identifiers and bounds never acquire an occupancy slot", () => {
    expect(() => createHostedAdmission({ maxRuns: 0.5, revokeInteractiveScope: () => {} })).toThrow(
      "positive safe integer",
    );
    const admission = createHostedAdmission({ revokeInteractiveScope: () => {} });
    const peer = admission.connect("operator");
    expect(() => admission.reserve(peer, "", "run", "execution")).toThrow("session id");
    expect(() => admission.reserve(peer, "session", "run")).toThrow("execution id");
    expect(() => admission.reserve(peer, "session", "shell", "execution")).toThrow("cannot claim");
    expect(admission.stats().runs).toBe(0);
  });
});
