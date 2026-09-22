import { bestEffort, NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { HostedRunFrame, HostedRunSnapshot, HostingService } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import { decodeHostedFrame, wireId } from "./hosting-codec.ts";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;

function corrupt(): Error {
  return kernelError("invalid_request", "hosted snapshot is incomplete or malformed");
}

/**
 * Decode one immutable snapshot incrementally with the same event codec as the live RPC tail.
 * Page boundaries may split UTF-8 characters or records. The reader validates byte/sequence
 * continuity through the advertised cut and releases the snapshot on completion or abandonment.
 * It holds at most one page plus one bounded record; it never retains the complete event history.
 */
export async function* readHostedSnapshot(
  service: Pick<HostingService, "readSnapshot" | "releaseSnapshot">,
  snapshot: HostedRunSnapshot,
  logger: Logger = NOOP_LOGGER,
): AsyncGenerator<HostedRunFrame> {
  if (
    !wireId(snapshot.snapshot_id) ||
    !wireId(snapshot.cursor.execution_id) ||
    !wireId(snapshot.cursor.host_generation) ||
    !Number.isSafeInteger(snapshot.bytes) ||
    snapshot.bytes < 0 ||
    !Number.isSafeInteger(snapshot.cursor.sequence) ||
    snapshot.cursor.sequence < 0
  )
    throw corrupt();
  let offset = 0;
  let sequence = 0;
  let fragments: string[] = [];
  let fragmentBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (offset < snapshot.bytes) {
      const page = await service.readSnapshot(snapshot.snapshot_id, offset);
      if (
        page.snapshot_id !== snapshot.snapshot_id ||
        page.offset !== offset ||
        typeof page.data_base64 !== "string" ||
        page.data_base64.length > Math.ceil(MAX_PAGE_BYTES / 3) * 4
      )
        throw corrupt();
      const bytes = Buffer.from(page.data_base64, "base64");
      if (
        bytes.length === 0 ||
        bytes.length > MAX_PAGE_BYTES ||
        bytes.toString("base64") !== page.data_base64 ||
        bytes.length > snapshot.bytes - offset
      )
        throw corrupt();
      offset += bytes.length;
      if (page.next_offset !== (offset < snapshot.bytes ? offset : undefined)) throw corrupt();
      let text: string;
      try {
        text = decoder.decode(bytes, { stream: offset < snapshot.bytes });
      } catch {
        throw corrupt();
      }
      let start = 0;
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
        const fragment = text.slice(start, end);
        fragmentBytes += Buffer.byteLength(fragment);
        if (fragmentBytes > MAX_RECORD_BYTES) throw corrupt();
        fragments.push(fragment);
        let frame: HostedRunFrame | null;
        try {
          frame = decodeHostedFrame(JSON.parse(fragments.join("")) as unknown);
        } catch {
          throw corrupt();
        }
        fragments = [];
        fragmentBytes = 0;
        if (
          frame === null ||
          frame.first_sequence !== sequence + 1 ||
          frame.last_sequence > snapshot.cursor.sequence
        )
          throw corrupt();
        sequence = frame.last_sequence;
        yield frame;
        start = end + 1;
      }
      if (start < text.length) {
        const fragment = text.slice(start);
        fragmentBytes += Buffer.byteLength(fragment);
        if (fragmentBytes > MAX_RECORD_BYTES) throw corrupt();
        fragments.push(fragment);
      }
    }
    if (fragments.length !== 0 || sequence !== snapshot.cursor.sequence) throw corrupt();
  } finally {
    await bestEffort(() => service.releaseSnapshot(snapshot.snapshot_id), {
      operation: "hosting.snapshot.release",
      logger,
    });
  }
}
