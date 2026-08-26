import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  lines,
  posixShell,
  monitorCapturesOutput,
} from "../helpers/fixtures.ts";
import { listSidecars, isAlive, readSidecar } from "../../src/lib/monitor.ts";
import { killTree } from "../../src/lib/process.ts";
import type { ServerConfig } from "../../src/config.ts";
import type { CallResult } from "../helpers/fixtures.ts";

const T = 15000;

async function pollUntil(
  fn: () => Promise<CallResult>,
  pred: (r: CallResult) => boolean,
  timeoutMs = 6000,
  stepMs = 25,
): Promise<CallResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await fn();
    if (pred(r) || Date.now() > deadline) return r;
    await new Promise((res) => setTimeout(res, stepMs));
  }
}

async function waitDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 20));
  }
  return !isAlive(pid);
}

describe("monitor", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(async () => {
    for (const m of await listSidecars(root)) {
      if (isAlive(m.pid)) killTree(m.pid, "SIGKILL");
    }
    cleanup(root);
  });

  it(
    "starts a background process and returns an id immediately",
    async () => {
      const r = await callTool("monitor_start", { command: "sleep 5" }, config);
      expect(r.isError).toBe(false);
      expect(r.json.running).toBe(true);
      expect(r.json.ready).toBe(null);
      expect(typeof r.json.id).toBe("string");
      expect(r.json.next_offset).toBe(0);
      await callTool("monitor_stop", { id: r.json.id as string }, config);
    },
    T,
  );

  it.skipIf(!monitorCapturesOutput)(
    "polls a finished monitor for its full output and exit code",
    async () => {
      const start = await callTool("monitor_start", { command: "printf 'a\\nb\\nc\\n'" }, config);
      const id = start.json.id as string;
      const done = await pollUntil(
        () => callTool("monitor_poll", { id, offset: 0 }, config),
        (r) => r.json.running === false,
      );
      expect(done.json.running).toBe(false);
      expect(lines(done.json.output)).toContain("a");
      expect(lines(done.json.output)).toContain("c");
      expect(done.json.exit_code).toBe(0);
    },
    T,
  );

  // Not a dialect gap: `exit 3` parses fine in PowerShell. It is the exit
  // sidecar that cannot carry it - exitCaptureWrapper tests `$?` ahead of
  // `$LASTEXITCODE`, so a PowerShell *statement* (as opposed to a native
  // command) can only ever record 0 or 1 there, which that function's own
  // TSDoc calls out as the deliberate cost of that ordering.
  it.skipIf(!posixShell)(
    "captures a non-zero natural exit code",
    async () => {
      const start = await callTool("monitor_start", { command: "exit 3" }, config);
      const id = start.json.id as string;
      const done = await pollUntil(
        () => callTool("monitor_poll", { id }, config),
        (r) => r.json.running === false,
      );
      expect(done.json.exit_code).toBe(3);
    },
    T,
  );

  it.skipIf(!posixShell)(
    "pages output forward by byte offset",
    async () => {
      const small = makeConfig(root, { maxOutputBytes: 1024 });
      const start = await callTool(
        "monitor_start",
        { command: "i=1; while [ $i -le 400 ]; do echo line$i; i=$((i+1)); done" },
        small,
      );
      const id = start.json.id as string;
      const first = await pollUntil(
        () => callTool("monitor_poll", { id, offset: 0 }, small),
        (r) => r.json.running === false,
      );
      expect(lines(first.json.output)).toContain("more output buffered");
      const next = first.json.next_offset as number;
      expect(next).toBeGreaterThan(0);
      const second = await callTool("monitor_poll", { id, offset: next }, small);
      expect((second.json.output as string).length).toBeGreaterThan(0);
      expect(second.json.next_offset as number).toBeGreaterThan(next);
    },
    T,
  );

  it.skipIf(!monitorCapturesOutput)(
    "filters output lines with a match regex",
    async () => {
      const start = await callTool(
        "monitor_start",
        { command: "printf 'apple\\nbanana\\ncherry\\n'" },
        config,
      );
      const id = start.json.id as string;
      const done = await pollUntil(
        () => callTool("monitor_poll", { id, offset: 0, match: "an" }, config),
        (r) => r.json.running === false,
      );
      expect(lines(done.json.output)).toContain("banana");
      expect(lines(done.json.output)).not.toContain("apple");
      expect(lines(done.json.output)).not.toContain("cherry");
    },
    T,
  );

  it(
    "returns empty when matching against a monitor with no output yet",
    async () => {
      const start = await callTool("monitor_start", { command: "sleep 2" }, config);
      const id = start.json.id as string;
      const r = await callTool("monitor_poll", { id, match: "anything" }, config);
      expect(r.isError).toBe(false);
      expect(lines(r.json.output)).toBe("");
      await callTool("monitor_stop", { id }, config);
    },
    T,
  );

  it(
    "rejects an invalid match regex",
    async () => {
      const start = await callTool("monitor_start", { command: "sleep 2" }, config);
      const id = start.json.id as string;
      const r = await callTool("monitor_poll", { id, match: "(" }, config);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("invalid_input");
      await callTool("monitor_stop", { id }, config);
    },
    T,
  );

  it.skipIf(!monitorCapturesOutput)(
    "blocks until ready_when matches, then returns while still running",
    async () => {
      const r = await callTool(
        "monitor_start",
        { command: "printf 'booting\\nlistening on 3000\\n'; sleep 3", ready_when: "listening on" },
        config,
      );
      expect(r.isError).toBe(false);
      expect(r.json.ready).toBe(true);
      expect(r.json.running).toBe(true);
      expect(lines(r.json.output)).toContain("listening on 3000");
      await callTool("monitor_stop", { id: r.json.id as string }, config);
    },
    T,
  );

  it(
    "returns ready:false when ready_when times out",
    async () => {
      const r = await callTool(
        "monitor_start",
        { command: "sleep 3", ready_when: "NEVER_MATCHES", ready_timeout_ms: 200 },
        config,
      );
      expect(r.json.ready).toBe(false);
      expect(r.json.running).toBe(true);
      await callTool("monitor_stop", { id: r.json.id as string }, config);
    },
    T,
  );

  it.skipIf(!monitorCapturesOutput)(
    "returns ready:false, running:false when the process dies before matching",
    async () => {
      const r = await callTool(
        "monitor_start",
        { command: "printf 'oops\\n'; exit 1", ready_when: "NEVER", ready_timeout_ms: 4000 },
        config,
      );
      expect(r.json.ready).toBe(false);
      expect(r.json.running).toBe(false);
      expect(lines(r.json.output)).toContain("oops");
    },
    T,
  );

  it("errors monitor_not_found for poll and stop on an unknown id", async () => {
    const p = await callTool("monitor_poll", { id: "mon_deadbeef" }, config);
    expect(p.isError).toBe(true);
    expect(p.json.error).toBe("monitor_not_found");
    const s = await callTool("monitor_stop", { id: "mon_deadbeef" }, config);
    expect(s.isError).toBe(true);
    expect(s.json.error).toBe("monitor_not_found");
  });

  it(
    "lists running and finished monitors",
    async () => {
      const a = await callTool("monitor_start", { command: "sleep 5" }, config);
      const b = await callTool("monitor_start", { command: "printf done\\n" }, config);
      const list = await callTool("monitor_list", {}, config);
      const mons = list.json.monitors as Array<{ id: string; running: boolean; command: string }>;
      expect(mons.length).toBeGreaterThanOrEqual(2);
      expect(mons.some((m) => m.id === a.json.id)).toBe(true);
      expect(mons.every((m) => typeof m.running === "boolean")).toBe(true);
      await callTool("monitor_stop", { id: a.json.id as string }, config);
      await callTool("monitor_stop", { id: b.json.id as string }, config);
    },
    T,
  );

  it(
    "stops a monitor, killing its process group and removing its files",
    async () => {
      const start = await callTool("monitor_start", { command: "sleep 30" }, config);
      const id = start.json.id as string;
      const { pid } = await readSidecar(root, id);
      expect(isAlive(pid)).toBe(true);

      const stop = await callTool("monitor_stop", { id }, config);
      expect(stop.json.stopped).toBe(true);
      expect(await waitDead(pid)).toBe(true);

      const poll = await callTool("monitor_poll", { id }, config);
      expect(poll.json.error).toBe("monitor_not_found");
    },
    T,
  );

  it(
    "stop is idempotent on an already-exited monitor",
    async () => {
      const start = await callTool("monitor_start", { command: "printf x\\n" }, config);
      const id = start.json.id as string;
      await pollUntil(
        () => callTool("monitor_poll", { id }, config),
        (r) => r.json.running === false,
      );
      const stop = await callTool("monitor_stop", { id }, config);
      expect(stop.json.stopped).toBe(true);
    },
    T,
  );

  it("rejects a cwd that escapes the workspace", async () => {
    const r = await callTool("monitor_start", { command: "true", cwd: "../outside" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("path_escape");
  });

  it("rejects a cwd that is not a directory", async () => {
    write(root, "afile.txt", "x");
    const r = await callTool("monitor_start", { command: "true", cwd: "afile.txt" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("not_a_file");
  });

  it("rejects an invalid ready_when regex", async () => {
    const r = await callTool("monitor_start", { command: "true", ready_when: "(" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("invalid_input");
  });

  it(
    "refuses to start beyond maxMonitors live monitors",
    async () => {
      const small = makeConfig(root, { maxMonitors: 1 });
      const a = await callTool("monitor_start", { command: "sleep 5" }, small);
      expect(a.isError).toBe(false);
      const b = await callTool("monitor_start", { command: "sleep 5" }, small);
      expect(b.isError).toBe(true);
      expect(b.json.error).toBe("too_many_monitors");
      await callTool("monitor_stop", { id: a.json.id as string }, small);
    },
    T,
  );

  it.skipIf(!monitorCapturesOutput)(
    "holds back a partial trailing line while the process is running",
    async () => {
      const start = await callTool(
        "monitor_start",
        { command: "printf 'complete\\npartial-no-newline'; sleep 3" },
        config,
      );
      const id = start.json.id as string;
      const poll = await pollUntil(
        () => callTool("monitor_poll", { id, offset: 0 }, config),
        (r) => (r.json.output as string).includes("complete") && r.json.running === true,
      );
      expect(lines(poll.json.output)).toContain("complete");
      expect((poll.json.output as string).endsWith("\n")).toBe(true);
      expect(lines(poll.json.output)).not.toContain("partial");
      await callTool("monitor_stop", { id }, config);
    },
    T,
  );

  it.skipIf(!monitorCapturesOutput)(
    "emits a final partial line once the process is dead",
    async () => {
      const start = await callTool("monitor_start", { command: "printf 'partial-tail'" }, config);
      const id = start.json.id as string;
      const done = await pollUntil(
        () => callTool("monitor_poll", { id, offset: 0 }, config),
        (r) => r.json.running === false,
      );
      expect(lines(done.json.output)).toBe("partial-tail");
    },
    T,
  );

  it(
    "honors an already-aborted signal during a readiness wait",
    async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const r = await callTool(
        "monitor_start",
        { command: "sleep 3", ready_when: "NEVER", ready_timeout_ms: 5000 },
        config,
        ctrl.signal,
      );
      expect(r.json.ready).toBe(false);
      expect(r.json.running).toBe(true);
      await callTool("monitor_stop", { id: r.json.id as string }, config);
    },
    T,
  );

  it(
    "escalates to SIGKILL when the process ignores SIGTERM",
    async () => {
      const start = await callTool(
        "monitor_start",
        { command: "trap '' TERM; while :; do sleep 0.05; done" },
        config,
      );
      const id = start.json.id as string;
      const { pid } = await readSidecar(root, id);
      const stop = await callTool("monitor_stop", { id }, config);
      expect(stop.json.stopped).toBe(true);
      expect(await waitDead(pid)).toBe(true);
    },
    T,
  );

  it.skipIf(!monitorCapturesOutput)(
    "returns a running monitor's newline-free output as-is",
    async () => {
      const start = await callTool(
        "monitor_start",
        { command: "printf 'nonewline'; sleep 3" },
        config,
      );
      const id = start.json.id as string;
      const poll = await pollUntil(
        () => callTool("monitor_poll", { id, offset: 0 }, config),
        (r) => (r.json.output as string).includes("nonewline") && r.json.running === true,
      );
      expect(lines(poll.json.output)).toBe("nonewline");
      await callTool("monitor_stop", { id }, config);
    },
    T,
  );

  it.skipIf(!monitorCapturesOutput)(
    "does not hold back when a running monitor's output ends on a newline",
    async () => {
      const start = await callTool(
        "monitor_start",
        { command: "printf 'l1\\nl2\\n'; sleep 3" },
        config,
      );
      const id = start.json.id as string;
      const poll = await pollUntil(
        () => callTool("monitor_poll", { id, offset: 0 }, config),
        (r) => (r.json.output as string).includes("l2") && r.json.running === true,
      );
      expect(lines(poll.json.output)).toBe("l1\nl2\n");
      await callTool("monitor_stop", { id }, config);
    },
    T,
  );

  it.skipIf(!monitorCapturesOutput)(
    "holds back a partial trailing line before applying the match filter",
    async () => {
      const start = await callTool(
        "monitor_start",
        { command: "printf 'first\\nbanana-tail'; sleep 3" },
        config,
      );
      const id = start.json.id as string;
      const poll = await pollUntil(
        () => callTool("monitor_poll", { id, offset: 0, match: "first" }, config),
        (r) => (r.json.output as string).includes("first") && r.json.running === true,
      );
      expect(lines(poll.json.output)).toContain("first");
      expect(lines(poll.json.output)).not.toContain("banana-tail");
      await callTool("monitor_stop", { id }, config);
    },
    T,
  );

  it.skipIf(!posixShell)(
    "keeps matching lines and pages forward when output overflows the byte cap",
    async () => {
      const small = makeConfig(root, { maxOutputBytes: 1024 });
      const start = await callTool(
        "monitor_start",
        { command: "i=1; while [ $i -le 400 ]; do echo line$i; i=$((i+1)); done" },
        small,
      );
      const id = start.json.id as string;
      const first = await pollUntil(
        () => callTool("monitor_poll", { id, offset: 0, match: "line1" }, small),
        (r) => r.json.running === false,
      );
      expect(lines(first.json.output)).toContain("line1");
      expect(lines(first.json.output)).toContain("more output buffered");
      const next = first.json.next_offset as number;
      const second = await callTool("monitor_poll", { id, offset: next, match: "line1" }, small);
      expect(second.json.next_offset as number).toBeGreaterThan(next);
    },
    T,
  );

  it.skipIf(!posixShell)(
    "does not detect a ready_when marker printed beyond maxOutputBytes",
    async () => {
      const small = makeConfig(root, { maxOutputBytes: 1024 });
      const r = await callTool(
        "monitor_start",
        {
          command:
            "i=1; while [ $i -le 40 ]; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done; echo READY; sleep 2",
          ready_when: "READY",
          ready_timeout_ms: 800,
        },
        small,
      );
      expect(r.json.ready).toBe(false);
      expect(r.json.running).toBe(true);
      await callTool("monitor_stop", { id: r.json.id as string }, small);
    },
    T,
  );

  it(
    "reports exit_code null for a monitor killed without a natural exit",
    async () => {
      const start = await callTool("monitor_start", { command: "sleep 5" }, config);
      const id = start.json.id as string;
      const { pid } = await readSidecar(root, id);
      killTree(pid, "SIGKILL");
      expect(await waitDead(pid)).toBe(true);
      const poll = await callTool("monitor_poll", { id }, config);
      expect(poll.json.running).toBe(false);
      expect(poll.json.exit_code).toBe(null);
    },
    T,
  );

  it(
    "frees a monitor slot once a monitor exits",
    async () => {
      const small = makeConfig(root, { maxMonitors: 1 });
      const a = await callTool("monitor_start", { command: "printf done\\n" }, small);
      const id = a.json.id as string;
      await pollUntil(
        () => callTool("monitor_poll", { id }, small),
        (r) => r.json.running === false,
      );
      const b = await callTool("monitor_start", { command: "sleep 1" }, small);
      expect(b.isError).toBe(false);
      await callTool("monitor_stop", { id: b.json.id as string }, small);
    },
    T,
  );
});
