import { describe, it, expect } from "../bun-test.ts";
import { mkdtempSync, rmSync, truncateSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MAX_JSON_CONTROL_FILE_BYTES, readJsonFile } from "../../src/json-file.ts";

const schema = z.object({ name: z.string(), count: z.number().int() }).strict();

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-json-file-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readJsonFile", () => {
  it("returns ok with the parsed, schema-typed value", () => {
    withDir((dir) => {
      const p = join(dir, "ok.json");
      writeFileSync(p, JSON.stringify({ name: "a", count: 2 }));
      expect(readJsonFile(p, schema)).toEqual({ ok: true, value: { name: "a", count: 2 } });
    });
  });

  it("flags a missing file with missing: true", () => {
    withDir((dir) => {
      const r = readJsonFile(join(dir, "absent.json"), schema);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.missing).toBe(true);
        expect(r.kind).toBe("unreadable");
        expect(r.error).toContain("absent.json");
      }
    });
  });

  it("reports malformed JSON without the missing flag", () => {
    withDir((dir) => {
      const p = join(dir, "bad.json");
      writeFileSync(p, "{ not json");
      const r = readJsonFile(p, schema);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.missing).toBeUndefined();
        expect(r.kind).toBe("parse");
        expect(r.error).toContain("invalid JSON");
        expect(r.error).toBe(`invalid JSON in ${p}: ${r.detail}`);
      }
    });
  });

  it("reports a schema violation with the failing path", () => {
    withDir((dir) => {
      const p = join(dir, "shape.json");
      writeFileSync(p, JSON.stringify({ name: "a", count: "two" }));
      const r = readJsonFile(p, schema);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.missing).toBeUndefined();
        expect(r.kind).toBe("schema");
        expect(r.at).toBe("count");
        expect(r.error).toBe(`invalid ${p}: count: ${r.detail}`);
      }
    });
  });

  it("reports (root) as the schema path for a top-level violation", () => {
    withDir((dir) => {
      const p = join(dir, "root.json");
      writeFileSync(p, JSON.stringify([1, 2]));
      const r = readJsonFile(p, schema);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("schema");
        expect(r.at).toBe("(root)");
      }
    });
  });

  it("treats a directory (or other unreadable path) as an error, not missing", () => {
    withDir((dir) => {
      const p = join(dir, "as-dir");
      mkdirSync(p);
      const r = readJsonFile(p, schema);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.missing).toBeUndefined();
    });
  });

  it("rejects an oversized sparse control document before parsing it", () => {
    withDir((dir) => {
      const p = join(dir, "huge.json");
      writeFileSync(p, "{}");
      truncateSync(p, MAX_JSON_CONTROL_FILE_BYTES + 1);
      const r = readJsonFile(p, schema);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("unreadable");
        expect(r.detail).toContain("resource limit");
      }
    });
  });
});
