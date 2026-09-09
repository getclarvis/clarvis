import { describe, expect, test } from "bun:test";
import { createHostedAdmission } from "../../src/hosting/admission.ts";

describe("hosted admission and interactive authority", () => {
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
