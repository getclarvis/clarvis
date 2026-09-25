import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../fixtures/hosted-settlement-crash.ts", import.meta.url));

for (const phase of [
  "reconcile_checkpoint",
  "session_committed",
  "terminal_committed",
  "steering_evidence",
  "goal_prepared",
]) {
  test(`physical process loss after ${phase} recovers canonical bookkeeping`, async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-settlement-crash-"));
    const children: Array<{
      process: Bun.Subprocess<"pipe", "pipe", "pipe">;
      errors: Promise<string>;
    }> = [];
    const spawn = (mode: string) => {
      /** Physical process fuse; readiness is the emitted durable-write milestone, never elapsed time. */
      const process = Bun.spawn([globalThis.process.execPath, fixture, root, mode, phase], {
        cwd: root,
        env: {
          PATH: globalThis.process.env.PATH,
          HOME: root,
          TMPDIR: root,
          TEMP: root,
          TMP: root,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(15_000),
      });
      const child = { process, errors: new Response(process.stderr).text() };
      children.push(child);
      return child;
    };
    try {
      const first = spawn("initial");
      const reader = first.process.stdout.getReader();
      let message = "";
      try {
        while (!message.includes("\n")) {
          const part = await reader.read();
          if (part.done) throw new Error(`fixture exited before milestone: ${await first.errors}`);
          message += new TextDecoder().decode(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      expect(JSON.parse(message.trim())).toEqual({ milestone: phase });
      first.process.kill("SIGKILL");
      await first.process.exited;
      expect(await first.errors).toBe("");
      for (let restart = 0; restart < 2; restart++) {
        const recovered = spawn("recover");
        const output = new Response(recovered.process.stdout).text();
        const code = await recovered.process.exited;
        expect(await recovered.errors).toBe("");
        expect(code).toBe(0);
        const value = JSON.parse(await output);
        if (phase === "steering_evidence") {
          expect(value).toMatchObject({
            occupied: true,
            starts: 1,
            totals: { input: 0, output: 0, cached: 0 },
            run: { execution_state: "unknown" },
          });
          expect(value.intents).toHaveLength(1);
          expect(value.intents[0]).toMatchObject({
            execution_id: "steer_crash",
            steering_target: "execution",
            admitted: true,
            delivered_to: "execution",
          });
          expect(value.turns).toHaveLength(1);
          expect(value.turns[0].ended_at).toBeUndefined();
          continue;
        }
        expect(value).toMatchObject({
          occupied: false,
          starts: 1,
          totals: { input: 17, output: 3, cached: 2 },
          run: {
            execution_state: "closed",
            outcome: { status: phase === "goal_prepared" ? "failed" : "completed" },
          },
        });
        expect(value.turns).toHaveLength(1);
        expect(value.turns[0]).toMatchObject({
          execution_id: "execution",
          status: phase === "goal_prepared" ? "error" : "done",
        });
        if (phase === "goal_prepared") {
          expect(value.goal.status).not.toBe("complete");
          expect(value.goal.runs).toHaveLength(1);
          expect(value.goal.runs[0]).toMatchObject({
            phase: "closed",
            activity_unavailable: true,
            usage: {
              kind: "partial",
              input: 17,
              output: 3,
              gaps: [{ cause: "no_usage", calls: 1, call_ids: ["uncertain-call"] }],
            },
          });
          expect(value.goal.runs[0].settlement_preparation).toBeUndefined();
        }
        expect(value.turns[0].ended_at).toBeNumber();
      }
    } finally {
      for (const child of children.reverse()) {
        child.process.kill("SIGKILL");
        await child.process.exited;
        await child.errors;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
