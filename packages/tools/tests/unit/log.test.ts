import { afterEach, describe, expect, it } from "bun:test";
import { serializeError, setWarnSink } from "../../src/index.ts";

function spyStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { writes, restore: () => (process.stderr.write = orig) };
}

describe("warn sink (F6)", () => {
  afterEach(() => setWarnSink(null));

  it("routes internal-error warnings to a custom sink instead of stderr", () => {
    const captured: string[] = [];
    setWarnSink((m) => captured.push(m));
    const stderr = spyStderr();
    let out: string;
    try {
      out = serializeError(new Error("boom"));
    } finally {
      stderr.restore();
    }
    expect(JSON.parse(out)).toMatchObject({ error: "internal", message: "internal error" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("internal error: ");
    expect(captured[0]).toContain("boom");
    expect(stderr.writes.join("")).toBe("");
  });

  it("setWarnSink(null) restores the default stderr sink", () => {
    const captured: string[] = [];
    setWarnSink((m) => captured.push(m));
    setWarnSink(null);
    const stderr = spyStderr();
    try {
      serializeError(new Error("again"));
    } finally {
      stderr.restore();
    }
    expect(captured).toHaveLength(0);
    expect(stderr.writes.join("")).toContain("internal error: ");
  });
});
