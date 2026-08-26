import { describe, expect, it } from "bun:test";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthConfigSource, readAuthConfig } from "../../src/auth/auth-config.ts";
import { cheapHash } from "../helpers/auth.ts";
import { recordingLoggers } from "../helpers/harness.ts";

const DEFAULTS = { publicUrl: undefined, mcpPath: "/mcp" };
const HASH = cheapHash("a-secret");

/** A minimal valid document, with the given fields overridden. */
function document(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    issuer: "https://clarvis.test",
    resource: "https://clarvis.test/mcp",
    clients: [{ client_id: "svc", secret_hash: HASH, owner: "acme", role: "user" }],
    ...over,
  };
}

describe("readAuthConfig and createAuthConfigSource", () => {
  it("fails closed at boot on a missing or malformed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-auth-cfg-"));
    try {
      expect(() => readAuthConfig(join(dir, "nope.json"), DEFAULTS)).toThrow(
        /cannot read auth config/,
      );
      const file = join(dir, "auth.json");
      writeFileSync(file, "{ not json");
      expect(() => readAuthConfig(file, DEFAULTS)).toThrow(/not valid JSON/);
      expect(() => createAuthConfigSource({ file, defaults: DEFAULTS })).toThrow(/not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed before reading an oversized sparse auth config", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-auth-cfg-"));
    const file = join(dir, "auth.json");
    const fd = openSync(file, "w");
    try {
      truncateSync(file, 64 * 1024 * 1024);
      expect(() => readAuthConfig(file, DEFAULTS)).toThrow(/exceeds/);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts an edit, and keeps the last good config when a later read fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-auth-cfg-"));
    const file = join(dir, "auth.json");
    try {
      writeFileSync(file, JSON.stringify(document()));
      const audit = recordingLoggers();
      const source = createAuthConfigSource({
        file,
        defaults: DEFAULTS,
        reloadThrottleMs: 0,
        audit: audit.loggers.audit,
      });
      expect(source.current().clients).toHaveLength(1);

      await Bun.sleep(5);
      writeFileSync(
        file,
        JSON.stringify(
          document({
            clients: [
              { client_id: "svc", secret_hash: HASH, owner: "acme" },
              { client_id: "svc2", secret_hash: HASH, owner: "acme" },
            ],
          }),
        ),
      );
      expect(source.current().clients).toHaveLength(2);

      await Bun.sleep(5);
      writeFileSync(file, "{ truncated");
      expect(source.current().clients).toHaveLength(2);
      expect(audit.find("auth.config.reload_failed")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the clients an adopted edit added, removed and disabled — ids, never hashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-auth-cfg-"));
    const file = join(dir, "auth.json");
    try {
      writeFileSync(
        file,
        JSON.stringify(
          document({
            clients: [
              { client_id: "svc", secret_hash: HASH, owner: "acme" },
              { client_id: "gone", secret_hash: HASH, owner: "acme" },
            ],
          }),
        ),
      );
      const logs = recordingLoggers();
      const source = createAuthConfigSource({
        file,
        defaults: DEFAULTS,
        reloadThrottleMs: 0,
        audit: logs.loggers.audit,
      });

      await Bun.sleep(5);
      writeFileSync(
        file,
        JSON.stringify(
          document({
            clients: [
              { client_id: "svc", secret_hash: HASH, owner: "acme", disabled: true },
              { client_id: "fresh", secret_hash: HASH, owner: "acme" },
            ],
          }),
        ),
      );
      expect(source.current().clients).toHaveLength(2);

      const record = logs.one("auth.config.reloaded");
      expect(record.channel).toBe("audit");
      expect(record.fields).toMatchObject({
        file,
        clients: 2,
        added: "fresh",
        removed: "gone",
        disabled: "svc",
      });
      expect(JSON.stringify(record.fields)).not.toContain(HASH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a vanished file as its own degradation, keeping every enrolled client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-auth-cfg-"));
    const file = join(dir, "auth.json");
    try {
      writeFileSync(file, JSON.stringify(document()));
      const logs = recordingLoggers();
      const source = createAuthConfigSource({
        file,
        defaults: DEFAULTS,
        reloadThrottleMs: 0,
        audit: logs.loggers.audit,
      });

      await Bun.sleep(5);
      unlinkSync(file);
      expect(source.current().clients).toHaveLength(1);

      const record = logs.one("auth.config.disappeared");
      expect(record.level).toBe("warn");
      expect(record.fields).toMatchObject({ file, kept_clients: 1 });
      expect(logs.find("auth.config.reload_failed")).toHaveLength(0);

      source.current();
      expect(logs.find("auth.config.disappeared")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says nothing while the file has not changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-auth-cfg-"));
    const file = join(dir, "auth.json");
    try {
      writeFileSync(file, JSON.stringify(document()));
      const logs = recordingLoggers();
      const source = createAuthConfigSource({
        file,
        defaults: DEFAULTS,
        reloadThrottleMs: 0,
        audit: logs.loggers.audit,
      });
      source.current();
      await Bun.sleep(5);
      source.current();
      expect(logs.records).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
