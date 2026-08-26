import { expect, test } from "bun:test";
import {
  connectionLabel,
  connectionProbe,
  createConnectionState,
} from "../../src/adapters/connection-state.ts";

test("a fresh connection is connecting; set() replaces the whole state", () => {
  const conn = createConnectionState();
  expect(conn.state()).toEqual({ phase: "connecting" });
  conn.set({ phase: "ready" });
  expect(conn.state().phase).toBe("ready");
});

test("the header label derives from the phase and never says 'mcp'", () => {
  expect(connectionLabel({ phase: "connecting" })).toBe("connecting…");
  expect(connectionLabel({ phase: "connecting", detail: "reconnecting" })).toBe("reconnecting…");
  expect(connectionLabel({ phase: "ready" })).toBe("connected");
  expect(connectionLabel({ phase: "ready", detail: "no profiles" })).toBe(
    "connected (no profiles)",
  );
  const failed = connectionLabel({ phase: "failed", detail: "boom" });
  expect(failed).toContain("backend");
  expect(failed.toLowerCase()).not.toContain("mcp");
});

test("the doctor probe derives from the same state the label does", () => {
  expect(connectionProbe({ phase: "connecting" }, 0)).toEqual({ status: "checking" });
  expect(connectionProbe({ phase: "ready" }, 3)).toEqual({
    status: "reachable",
    profileCount: 3,
  });
  expect(connectionProbe({ phase: "failed", detail: "x" }, 3)).toEqual({ status: "unreachable" });
});
