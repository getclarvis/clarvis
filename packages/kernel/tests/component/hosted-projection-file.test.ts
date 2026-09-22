import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsyncDir } from "@clarvis/paths";
import { createHostedProjection, openHostedProjection } from "../../src/hosting/projection.ts";
import {
  openProjectionStorage,
  removeProjectionStorage,
} from "../../src/hosting/projection-storage.ts";
import { readHostedSnapshot } from "../../src/transport/hosted-snapshot.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file-backed hosted projection", () => {
  test("recovers positional writes and rotation sync without duplicating frames or changing a snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-projection-recovery-"));
    roots.push(root);
    const file = join(root, "observation.jsonl");
    let lostWrite = false;
    let interruptedWrite = false;
    let directoryCalls = 0;
    let lostSync = false;
    let waits = 0;
    const transient = (code: string) => Object.assign(new Error("injected IO fault"), { code });
    const storage = await openProjectionStorage(file, 128, {
      async wait() {
        waits++;
      },
      async syncDirectory(path) {
        await fsyncDir(path);
        if (++directoryCalls === 2) throw transient("EIO");
      },
      async openFile(path, flags, mode) {
        const handle = await open(path, flags, mode);
        return {
          async write(bytes, offset, length, position) {
            if (path.endsWith(".segment.1") && !interruptedWrite) {
              interruptedWrite = true;
              throw transient("EINTR");
            }
            const result = await handle.write(bytes, offset, length, position);
            if (!lostWrite) {
              lostWrite = true;
              throw transient("EIO");
            }
            return result;
          },
          read: (bytes, offset, length, position) => handle.read(bytes, offset, length, position),
          async sync() {
            await handle.sync();
            if (!lostSync) {
              lostSync = true;
              throw transient("EAGAIN");
            }
          },
          close: () => handle.close(),
        };
      },
    });
    const projection = createHostedProjection(storage, { host_generation: "g", execution_id: "e" });
    try {
      await projection.append({ type: "run_started", at: 1 });
      const first = await projection.snapshot();
      const frozen = await projection.readPage(first.snapshot_id, 0);
      await projection.append({ type: "run_ended", at: 2, status: "completed" });
      const last = await projection.snapshot();
      const service = {
        readSnapshot: (id: string, offset: number) => projection.readPage(id, offset),
        async releaseSnapshot(id: string) {
          projection.releaseSnapshot(id);
        },
      };
      expect(await projection.readPage(first.snapshot_id, 0)).toEqual(frozen);
      expect(
        (await Array.fromAsync(readHostedSnapshot(service, last))).map(
          (frame) => frame.last_sequence,
        ),
      ).toEqual([1, 2]);
      expect(waits).toBe(4);
      expect(projection.failure()).toBeUndefined();
      expect(directoryCalls).toBe(3);
    } finally {
      await projection.close();
    }
  });

  test("streams beyond the former lifetime quota with bounded segments and immutable cuts", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-hosted-segments-"));
    roots.push(root);
    const file = join(root, "observation.jsonl");
    const projection = await openHostedProjection(file, {
      host_generation: "generation",
      execution_id: "execution",
    });
    try {
      await projection.append({ type: "run_started", at: 1 });
      const first = await projection.snapshot();
      for (let i = 0; i < 65; i++) {
        await projection.append({
          type: "text_delta",
          at: i + 2,
          agent: "lead",
          iteration: 1,
          channel: "text",
          reset: false,
          text: "λ".repeat(512 * 1024),
        });
      }
      const last = await projection.snapshot();
      expect(last.bytes).toBeGreaterThan(64 * 1024 * 1024);
      const service = {
        readSnapshot: (id: string, offset: number) => projection.readPage(id, offset),
        async releaseSnapshot(id: string) {
          projection.releaseSnapshot(id);
        },
      };
      expect((await Array.fromAsync(readHostedSnapshot(service, first))).length).toBe(1);
      let count = 0;
      for await (const frame of readHostedSnapshot(service, last)) {
        count++;
        expect(frame.last_sequence).toBe(count);
      }
      expect(count).toBe(66);
      expect((await stat(file)).size).toBe(64 * 1024 * 1024);
      expect((await stat(`${file}.segment.1`)).size).toBeLessThan(2 * 1024 * 1024);
    } finally {
      await projection.close();
    }
    const neighbor = `${file}.segment.foreign`;
    await writeFile(neighbor, "preserve");
    await removeProjectionStorage(file);
    expect(await readdir(root)).toEqual(["observation.jsonl.segment.foreign"]);
    await removeProjectionStorage(file);
  });

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
