import { describe, expect, test } from "bun:test";
import type {
  HostedRunFrame,
  HostedRunSnapshot,
  HostingService,
  RunEvent,
} from "@clarvis/protocol";
import { readHostedSnapshot } from "../../src/transport/hosted-snapshot.ts";

const delta = (text: string): RunEvent => ({
  type: "text_delta",
  agent: "lead",
  at: 1,
  iteration: 1,
  channel: "text",
  reset: false,
  text,
});
const frames: HostedRunFrame[] = [
  { first_sequence: 1, last_sequence: 3, event: delta("ação 🌍") },
  { first_sequence: 4, last_sequence: 4, event: delta("tail") },
];

function fixture(body = frames.map((frame) => `${JSON.stringify(frame)}\n`).join("")) {
  const bytes = Buffer.from(body);
  const reads: number[] = [];
  const released: string[] = [];
  const snapshot: HostedRunSnapshot = {
    snapshot_id: "snapshot",
    cursor: { host_generation: "generation", execution_id: "execution", sequence: 4 },
    bytes: bytes.length,
  };
  const service: Pick<HostingService, "readSnapshot" | "releaseSnapshot"> = {
    async readSnapshot(id, offset) {
      reads.push(offset);
      const end = Math.min(offset + 1, bytes.length);
      return {
        snapshot_id: id,
        offset,
        data_base64: bytes.subarray(offset, end).toString("base64"),
        ...(end === bytes.length ? {} : { next_offset: end }),
      };
    },
    async releaseSnapshot(id) {
      released.push(id);
    },
  };
  return { bytes, reads, released, snapshot, service };
}

describe("hosted snapshot reader", () => {
  test("decodes split UTF-8 and lossless sequence intervals without retaining the history", async () => {
    const f = fixture();
    expect(await Array.fromAsync(readHostedSnapshot(f.service, f.snapshot))).toEqual(frames);
    expect(f.reads.length).toBe(f.bytes.length);
    expect(f.released).toEqual(["snapshot"]);
  });

  test("releases an abandoned snapshot without requesting its remaining pages", async () => {
    const f = fixture();
    for await (const frame of readHostedSnapshot(f.service, f.snapshot)) {
      expect(frame).toEqual(frames[0]!);
      break;
    }
    expect(f.reads.length).toBeLessThan(f.bytes.length);
    expect(f.released).toEqual(["snapshot"]);
  });

  test.each([
    "{private malformed payload}\n",
    JSON.stringify(frames[0]),
    `${JSON.stringify(frames[1])}\n`,
    `${JSON.stringify(frames[0])}\n`,
    `${JSON.stringify({ ...frames[0], event: { type: "foreign" } })}\n`,
  ])("rejects corrupt or incomplete prefixes and still releases the snapshot: %s", async (body) => {
    const f = fixture(body);
    await expect(Array.fromAsync(readHostedSnapshot(f.service, f.snapshot))).rejects.toThrow(
      "hosted snapshot is incomplete or malformed",
    );
    expect(f.released).toEqual(["snapshot"]);
  });

  test("rejects identity, offset, base64 and EOF violations before parsing their payloads", async () => {
    for (const patch of [
      { snapshot_id: "foreign" },
      { offset: 1 },
      { data_base64: "e!w==" },
      { data_base64: "" },
      { next_offset: 0 },
      { data_base64: "A".repeat(1_398_105) },
    ]) {
      const f = fixture();
      const read = f.service.readSnapshot;
      f.service.readSnapshot = async (id, offset) => ({ ...(await read(id, offset)), ...patch });
      await expect(Array.fromAsync(readHostedSnapshot(f.service, f.snapshot))).rejects.toThrow();
      expect(f.released).toEqual(["snapshot"]);
    }
  });

  test("rejects an oversized declaration without requesting data and releases an empty cut", async () => {
    const f = fixture();
    await expect(
      Array.fromAsync(
        readHostedSnapshot(f.service, { ...f.snapshot, bytes: 64 * 1024 * 1024 + 1 }),
      ),
    ).rejects.toThrow();
    expect(f.reads).toEqual([]);
    expect(
      await Array.fromAsync(
        readHostedSnapshot(f.service, {
          ...f.snapshot,
          bytes: 0,
          cursor: { ...f.snapshot.cursor, sequence: 0 },
        }),
      ),
    ).toEqual([]);
    expect(f.released).toEqual(["snapshot"]);
  });
});
