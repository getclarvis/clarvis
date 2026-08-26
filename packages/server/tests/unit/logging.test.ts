import { describe, expect, it } from "bun:test";
import { NOOP_LOGGER, sanitizeErrorMessage } from "@clarvis/capability";
import {
  createServerLoggers,
  logHttpRequest,
  newInstanceId,
  newRequestId,
  ownerFields,
  REQUEST_ID_HEADER,
  SILENT_SERVER_LOGGERS,
  type RequestLogFields,
} from "../../src/logging.ts";
import { recordingLoggers } from "../helpers/harness.ts";

const FIELDS: RequestLogFields = {
  method: "POST",
  path: "/mcp",
  status: 200,
  dur_ms: 3,
  req_bytes: 42,
};

describe("createServerLoggers", () => {
  it("stamps a binding on both channels at once", () => {
    const logs = recordingLoggers();
    const child = logs.loggers.child({ req_id: "abc" });
    child.log.info({ event: "diag" }, "d");
    child.audit.warn({ event: "audit" }, "a");

    expect(logs.one("diag").fields.req_id).toBe("abc");
    expect(logs.one("audit").fields.req_id).toBe("abc");
    expect(logs.one("audit").channel).toBe("audit");
  });

  it("nests, so a run keeps its session's bindings", () => {
    const logs = recordingLoggers();
    logs.loggers
      .child({ session_id: "s1", owner: "acme" })
      .child({ execution_id: "e1" })
      .log.info({ event: "run.started" }, "started");

    expect(logs.one("run.started").fields).toMatchObject({
      session_id: "s1",
      owner: "acme",
      execution_id: "e1",
    });
  });

  it("degrades to the undecorated logger when the backend has no child", () => {
    const bare = { ...NOOP_LOGGER };
    delete (bare as { child?: unknown }).child;
    const loggers = createServerLoggers(bare, bare);
    expect(loggers.child({ req_id: "x" }).log).toBe(bare);
  });

  it("has a shared silent pair whose children are also silent", () => {
    expect(() => {
      SILENT_SERVER_LOGGERS.child({ req_id: "x" }).log.error({ event: "e" }, "m");
    }).not.toThrow();
  });
});

describe("ownerFields", () => {
  it("marks the owner authenticated only under token mode", () => {
    expect(ownerFields("acme", "token")).toEqual({ owner: "acme", owner_authenticated: true });
    for (const mode of ["fixed", "header", "allowlist"] as const) {
      expect(ownerFields("acme", mode)).toEqual({ owner: "acme", owner_authenticated: false });
    }
  });
});

describe("logHttpRequest", () => {
  it("writes nothing at all when requests are off", () => {
    const logs = recordingLoggers();
    logHttpRequest(logs.loggers.log, "off", { ...FIELDS, status: 500 });
    expect(logs.records).toHaveLength(0);
  });

  it("writes only failures in the default mode", () => {
    const logs = recordingLoggers();
    logHttpRequest(logs.loggers.log, "errors", FIELDS);
    expect(logs.find("http.request")).toHaveLength(0);

    logHttpRequest(logs.loggers.log, "errors", { ...FIELDS, status: 503 });
    expect(logs.one("http.request").fields).toMatchObject({ status: 503, path: "/mcp" });
  });

  it("writes every exchange in `all`", () => {
    const logs = recordingLoggers();
    logHttpRequest(logs.loggers.log, "all", FIELDS);
    expect(logs.one("http.request").fields).toMatchObject({
      method: "POST",
      status: 200,
      req_bytes: 42,
    });
  });
});

describe("newRequestId", () => {
  it("is twelve hex digits, the house length for an opaque id", () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{12}$/);
  });

  it("survives the redaction rules unchanged, so correlation is not withheld", () => {
    const id = newRequestId();
    expect(sanitizeErrorMessage(`req_id=${id}`)).toContain(id);
  });

  it("is distinct per call", () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });

  it("mints the process's own id the same way", () => {
    expect(newInstanceId()).toMatch(/^[0-9a-f]{12}$/);
    expect(sanitizeErrorMessage(newInstanceId())).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("REQUEST_ID_HEADER", () => {
  it("is namespaced, so it cannot collide with a caller's own header", () => {
    expect(REQUEST_ID_HEADER).toBe("x-clarvis-request-id");
  });
});
