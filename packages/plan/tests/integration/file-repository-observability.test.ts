/**
 * The file adapter's two silent skips. Both are correct — one broken plan must
 * not make the rest unlistable — but before this they were indistinguishable
 * from a plan that had never been written.
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFilePlanRepository } from "@clarvis/plan";

import { recordingLogger } from "../helpers/recording-logger.ts";

/**
 * Whether an unreadable file is actually unreadable here. Root ignores the mode
 * bits and Windows does not express them, so the `rescan` case probes rather
 * than assuming from the platform.
 */
const unreadableFilesPossible = await (async (): Promise<boolean> => {
  const base = await mkdtemp(join(tmpdir(), "clarvis-plan-perm-probe-"));
  const file = join(base, "probe");
  try {
    await writeFile(file, "x");
    await chmod(file, 0o000);
    const handle = await open(file, "r");
    await handle.close();
    return false;
  } catch {
    return true;
  } finally {
    await rm(base, { recursive: true, force: true });
  }
})();

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clarvis-plan-observability-"));
}

describe("plan.document.unparsable", () => {
  test("reports a plan the full-document listing skips", async () => {
    const dir = await workspace();
    const log = recordingLogger();
    const repository = createFilePlanRepository({ workspaceRoot: dir, logger: log.logger });
    try {
      await repository.create({
        id: "keep-me",
        source: [
          "---",
          "id: keep-me",
          "title: Keep me",
          "status: active",
          "retention: keep",
          "revision: 1",
          "spec_revision: 1",
          "created_at: 2026-07-27T10:00:00.000Z",
          "updated_at: 2026-07-27T10:00:00.000Z",
          "created_by_run: run-1",
          "---",
          "",
          "## Objective",
          "",
          "o",
          "",
          "## Context",
          "",
          "## Tasks",
          "",
          "- [ ] (t1) One",
          "",
          "## Validation",
          "",
          "## Notes",
          "",
        ].join("\n"),
        index: {
          title: "Keep me",
          status: "active",
          retention: "keep",
          revision: 1,
          spec_revision: 1,
          created_at: "2026-07-27T10:00:00.000Z",
          updated_at: "2026-07-27T10:00:00.000Z",
          created_by_run: "run-1",
          path: "2026-07-27T10-00-00-keep-me.md",
        },
      });
      await writeFile(
        join(dir, ".clarvis", "plans", "2026-07-28T10-00-00-broken.md"),
        "not a plan at all",
      );

      const page = await repository.list();
      expect(page.records.map((r) => r.id)).toEqual(["keep-me"]);
      const record = log.one("plan.document.unparsable");
      expect(record.level).toBe("warn");
      expect(record.fields.layer).toBe("list");
      expect(record.fields.path).toBe("2026-07-28T10-00-00-broken.md");
      expect(String(record.fields.reason).length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps a hand-edited plan's own body off the record", async () => {
    const dir = await workspace();
    const log = recordingLogger();
    const repository = createFilePlanRepository({ workspaceRoot: dir, logger: log.logger });
    try {
      await repository.list();
      const body = "confidential-plan-text ".repeat(200);
      await writeFile(
        join(dir, ".clarvis", "plans", "2026-07-30T10-00-00-handedited.md"),
        `---\nid: handedited\n\t${body}\n---\n\n## Objective\n\no\n`,
      );

      expect((await repository.list()).records).toHaveLength(0);
      const reason = String(log.one("plan.document.unparsable").fields.reason);
      // A YAMLParseError quotes the lines it choked on, so this is the one log
      // field that can carry plan prose. It stays one bounded line.
      expect(reason).not.toContain("\n");
      expect(reason.length).toBeLessThanOrEqual(500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!unreadableFilesPossible)(
    "reports a plan the locator rescan cannot even read",
    async () => {
      const dir = await workspace();
      const log = recordingLogger();
      const repository = createFilePlanRepository({ workspaceRoot: dir, logger: log.logger });
      const unreadable = join(dir, ".clarvis", "plans", "2026-07-29T10-00-00-locked.md");
      try {
        await repository.list();
        await writeFile(unreadable, "---\nid: locked\n---\n");
        await chmod(unreadable, 0o000);

        expect(await repository.read("never-written")).toBeNull();
        const record = log.one("plan.document.unparsable");
        expect(record.fields.layer).toBe("rescan");
        expect(record.fields.path).toBe("2026-07-29T10-00-00-locked.md");
      } finally {
        await chmod(unreadable, 0o600).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
