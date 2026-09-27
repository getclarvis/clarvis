import { expect, test } from "bun:test";
import {
  runTestTemporaryAudit,
  temporaryAuditExit,
  type AuditedCommand,
  TestCommandExecutionError,
  type TemporaryAuditEvent,
  type TemporaryAuditIo,
} from "../../lib/test-temporary-audit.ts";

const command: AuditedCommand = {
  argv: ["test"],
  cwd: "/fixture",
  env: {},
  signal: new AbortController().signal,
};

function fakeIo(overrides: Partial<TemporaryAuditIo> = {}): TemporaryAuditIo {
  return {
    acquire: () => Promise.resolve("/audit/owned"),
    inspect: () => Promise.resolve([]),
    remove: () => Promise.resolve(),
    ...overrides,
  };
}

test("clean completion preserves the command exit", () => {
  const success = { code: 0, signal: null };
  const failure = { code: 7, signal: null };
  expect(temporaryAuditExit(success, [])).toBe(success);
  expect(temporaryAuditExit(failure, [])).toBe(failure);
});

test("a passing command with residue fails; a failing command keeps its status", () => {
  expect(temporaryAuditExit({ code: 0, signal: null }, ["leftover"])).toEqual({
    code: 1,
    signal: null,
  });
  const crash = { code: 139, signal: "SIGSEGV" as const };
  expect(temporaryAuditExit(crash, ["leftover"])).toBe(crash);
  const assertion = { code: 3, signal: null };
  expect(temporaryAuditExit(assertion, ["leftover"])).toBe(assertion);
});

test("an inspection failure fails and still contains a settled command", async () => {
  const events: TemporaryAuditEvent[] = [];
  let removed = false;
  await expect(
    runTestTemporaryAudit(command, "inspection", {
      parent: "/audit",
      io: fakeIo({
        inspect: () => Promise.reject(new Error("inspection refused")),
        remove: () => {
          removed = true;
          return Promise.resolve();
        },
      }),
      execute: () => Promise.resolve({ code: 0, signal: null }),
      emit: (event) => events.push(event),
    }),
  ).rejects.toThrow("inspection refused");
  expect(removed).toBe(true);
  expect(events.map((event) => event.phase)).toEqual(["result", "observation", "containment"]);
});

test("a containment failure retains the observed residue and names its area", async () => {
  const events: TemporaryAuditEvent[] = [];
  await expect(
    runTestTemporaryAudit(command, "removal", {
      parent: "/audit",
      io: fakeIo({
        inspect: () => Promise.resolve(["leftover"]),
        remove: () => Promise.reject(new Error("removal refused")),
      }),
      execute: () => Promise.resolve({ code: 7, signal: null }),
      emit: (event) => events.push(event),
    }),
  ).rejects.toThrow("removal refused");
  expect(events[0]?.exit?.code).toBe(7);
  expect(events[1]?.remaining).toEqual(["leftover"]);
  expect(events[2]?.root).toBe("/audit/owned");
});

test("a pre-spawn cancellation removes its area and retains the abort reason", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  let removed = false;
  await expect(
    runTestTemporaryAudit({ ...command, signal: controller.signal }, "cancel", {
      parent: "/audit",
      io: fakeIo({
        remove: () => {
          removed = true;
          return Promise.resolve();
        },
      }),
      emit: () => {},
      execute: () => {
        controller.abort(reason);
        return Promise.reject(new TestCommandExecutionError("aborted", true, { cause: reason }));
      },
    }),
  ).rejects.toBe(reason);
  expect(removed).toBe(true);
});
