import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHostedProjection } from "../../src/hosting/projection.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file-backed hosted projection", () => {
  test("writes private durable pages and refuses to overwrite an existing execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-hosted-projection-"));
    roots.push(root);
    const file = join(root, "private", "observation.jsonl");
    const identity = { host_generation: "generation", execution_id: "execution" };
    const projection = await openHostedProjection(file, identity, { pageBytes: 37 });
    try {
      await projection.append({ type: "run_started", at: 1 });
      const snapshot = await projection.snapshot();
      await projection.append({ type: "run_ended", at: 2, status: "completed" });
      const parts: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const page = await projection.readPage(snapshot.snapshot_id, offset);
        parts.push(Buffer.from(page.data_base64, "base64"));
        if (page.next_offset === undefined) break;
        offset = page.next_offset;
      }
      expect(Buffer.concat(parts).length).toBe(snapshot.bytes);
      expect(Buffer.concat(parts).toString("utf8")).not.toContain("run_ended");
      await expect(openHostedProjection(file, identity)).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await projection.close();
    }
    expect((await readFile(file, "utf8")).trim().split("\n").length).toBe(2);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("an invalid projection configuration still closes its opened file", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-hosted-projection-"));
    roots.push(root);
    const file = join(root, "invalid.jsonl");
    await expect(
      openHostedProjection(file, { host_generation: "g", execution_id: "e" }, { maxBytes: 0 }),
    ).rejects.toThrow("positive safe integer");
    await rm(file);
    expect(await stat(file).catch(() => null)).toBeNull();
  });
});
