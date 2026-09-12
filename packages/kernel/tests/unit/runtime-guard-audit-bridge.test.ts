import { describe, expect, it } from "bun:test";
import type { Logger } from "@clarvis/capability";

import {
  createGuestGuardAuditLogger,
  forwardGuestGuardAudit,
} from "../../src/runtime/guard-audit-bridge.ts";

function captureLogger(
  records: Array<{ level: string; value: unknown; message?: string }>,
): Logger {
  const write =
    (level: string): Logger["info"] =>
    (value: unknown, ...args: unknown[]) => {
      const message = typeof args[0] === "string" ? args[0] : undefined;
      records.push({ level, value, ...(message === undefined ? {} : { message }) });
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

describe("runtime guard audit bridge", () => {
  it("serializes guest logger bindings and rebinds authenticated host identity", () => {
    const events: unknown[] = [];
    const guest = createGuestGuardAuditLogger((event) => events.push(event));
    guest.child?.({ run_id: "forged", owner: "forged" }).info(
      {
        event: "guard.decision",
        verdict: "allow",
        matched: "allow_list",
        mode: "on",
        tool: "shell",
        command_digest: "0123456789abcdef",
      },
      "ignored",
    );
    const records: Array<{ level: string; value: unknown; message?: string }> = [];
    expect(
      forwardGuestGuardAudit(events[0], captureLogger(records), "host-run", "host-owner"),
    ).toBe(true);
    expect(records).toEqual([
      {
        level: "info",
        value: {
          event: "guard.decision",
          verdict: "allow",
          matched: "allow_list",
          mode: "on",
          tool: "shell",
          command_digest: "0123456789abcdef",
          run_id: "host-run",
          owner: "host-owner",
        },
        message: "the command guard ruled on a guest tool call",
      },
    ]);
  });

  it("accepts dangerous asks without transmitting commands or operator intent", () => {
    const events: unknown[] = [];
    createGuestGuardAuditLogger((event) => events.push(event)).info({
      event: "guard.decision",
      verdict: "ask",
      matched: "dangerous",
      mode: "auto",
      tool: "shell",
      operator_message: "private intent",
      command: "private command",
    });
    const records: Array<{ level: string; value: unknown; message?: string }> = [];
    expect(forwardGuestGuardAudit(events[0], captureLogger(records), "run", "owner")).toBe(true);
    expect(records[0]?.value).toMatchObject({ matched: "dangerous", verdict: "ask" });
    expect(JSON.stringify(records)).not.toContain("private");
  });

  it("accepts only the closed guard audit vocabulary", () => {
    const records: Array<{ level: string; value: unknown; message?: string }> = [];
    const logger = captureLogger(records);
    expect(forwardGuestGuardAudit({ channel: "trace" }, logger, "run", "owner")).toBe(false);
    for (const event of [
      {
        channel: "guard_audit",
        level: "info",
        fields: {
          event: "guard.resolved",
          mode: "auto",
          source: "settings",
          judge_configured: true,
          human_channel: false,
        },
      },
      {
        channel: "guard_audit",
        level: "info",
        fields: {
          event: "guard.elicit.answered",
          answer: "allow_session",
          answerer: "session_allowlist",
        },
      },
      {
        channel: "guard_audit",
        level: "warn",
        fields: { event: "guard.escalation.no_channel", run_id: "forged" },
      },
    ]) {
      expect(forwardGuestGuardAudit(event, logger, "run", "owner")).toBe(true);
    }
    expect(records).toHaveLength(3);
    expect(() =>
      forwardGuestGuardAudit(
        {
          channel: "guard_audit",
          level: "info",
          fields: { event: "guard.decision", verdict: "allow" },
        },
        logger,
        "run",
        "owner",
      ),
    ).toThrow("audit envelope is invalid");
  });
});
