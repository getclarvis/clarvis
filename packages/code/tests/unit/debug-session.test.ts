import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebugSessionController } from "../../src/adapters/debug-session.ts";
import { createDiagnosticSession } from "../../src/adapters/diagnostic-session.ts";
import {
  activeDiagnosticLogger,
  activeDiagnosticSession,
  diagnosticBind,
  diagnosticEvent,
  installDiagnosticSession,
  isDiagnosticLevel,
} from "../../src/core/diagnostic-events.ts";

const made: string[] = [];
let cleanup: (() => void) | undefined;

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "clarvis-debug-controller-"));
  made.push(directory);
  return directory;
}

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function controllerOver(directory: string): ReturnType<typeof createDebugSessionController> {
  const controller = createDebugSessionController({
    create: (level) => createDiagnosticSession({ directory, level }),
  });
  cleanup = () => controller.dispose();
  return controller;
}

test("the controller reports closed until /debug opens a session", () => {
  const controller = controllerOver(tempDir());
  expect(controller.status()).toEqual({ open: false });
  expect(activeDiagnosticSession()).toBeUndefined();
  expect(activeDiagnosticLogger()).toBeUndefined();

  const opened = controller.open();
  expect(controller.status()).toEqual({ open: true, path: opened.path, level: "debug" });
  expect(activeDiagnosticSession()?.path).toBe(opened.path);
  expect(activeDiagnosticLogger()).toBeDefined();
});

test("re-opening retunes the session in place instead of splitting the record", () => {
  const controller = controllerOver(tempDir());
  const first = controller.open();
  const second = controller.open("warn");

  // One process, one file. A second file would split the record: the kernel is
  // handed its logger once at construction, so it would keep writing into the
  // first while this UI's events moved to the second, and neither would be the
  // whole story.
  expect(second.path).toBe(first.path);
  expect(second.retuned).toBe(true);
  expect(second.level).toBe("warn");
  expect(controller.status().level).toBe("warn");
  expect(activeDiagnosticSession()?.path).toBe(first.path);
  expect(readFileSync(first.path, "utf8")).not.toContain("diagnostics.stop");
  expect(readFileSync(first.path, "utf8")).toContain("diagnostics.level");
});

test("the first open reports that it is not a retune, so the caller can say what it misses", () => {
  const controller = controllerOver(tempDir());
  expect(controller.open().retuned).toBe(false);
});

test("free functions reach the session the controller installed, and stop when it closes", () => {
  const controller = controllerOver(tempDir());
  const opened = controller.open();
  diagnosticBind({ workspace: "/home/user/project" });
  diagnosticEvent("view.opened", { route: "doctor" }, "info");

  const closed = controller.close();
  expect(closed).toBe(opened.path);
  expect(controller.status()).toEqual({ open: false });
  diagnosticEvent("after.close", {}, "info");

  const written = readFileSync(opened.path, "utf8");
  expect(written).toContain("view.opened");
  expect(written).toContain("/home/user/project");
  expect(written).not.toContain("after.close");
});

test("closing twice, or closing nothing, reports that there was nothing to close", () => {
  const controller = controllerOver(tempDir());
  expect(controller.close()).toBeNull();
  controller.open();
  expect(controller.close()).not.toBeNull();
  expect(controller.close()).toBeNull();
});

test("a session the controller did not open is left for its own owner to close", () => {
  const directory = tempDir();
  const foreign = createDiagnosticSession({ directory });
  const uninstall = installDiagnosticSession(foreign);
  const controller = controllerOver(directory);
  try {
    expect(controller.status()).toEqual({
      open: true,
      path: foreign.path,
      level: "debug",
    });
    expect(controller.close()).toBeNull();
    expect(activeDiagnosticSession()?.path).toBe(foreign.path);
  } finally {
    uninstall();
    foreign.close();
  }
});

test("dispose releases the controller's own session", () => {
  const controller = controllerOver(tempDir());
  const opened = controller.open("info");
  controller.dispose();
  expect(activeDiagnosticSession()).toBeUndefined();
  expect(readFileSync(opened.path, "utf8")).toContain("diagnostics.stop");
});

test("the default factory writes into the workspace's own machine-local state", () => {
  const home = tempDir();
  const workspace = tempDir();
  const previousHome = process.env.CLARVIS_HOME;
  process.env.CLARVIS_HOME = home;
  const controller = createDebugSessionController({ workspace });
  try {
    const opened = controller.open("info");
    expect(opened.path.startsWith(home)).toBe(true);
    expect(opened.path).toContain("diagnostics");
    expect(readFileSync(opened.path, "utf8")).toContain("diagnostics.start");
  } finally {
    controller.dispose();
    if (previousHome === undefined) delete process.env.CLARVIS_HOME;
    else process.env.CLARVIS_HOME = previousHome;
  }
});

test("isDiagnosticLevel admits exactly the four recorded levels", () => {
  for (const level of ["debug", "info", "warn", "error"])
    expect(isDiagnosticLevel(level)).toBe(true);
  for (const other of ["trace", "fatal", "silent", "", "DEBUG"])
    expect(isDiagnosticLevel(other)).toBe(false);
});

test("diagnosticBind with no session installed is inert", () => {
  expect(() => diagnosticBind({ workspace: "/nowhere" })).not.toThrow();
});
