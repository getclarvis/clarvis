import { describe, it, expect } from "bun:test";
import {
  checkOriginAndHost,
  isInitializeBody,
  readBoundedBodyText,
  readJsonBody,
  rpcMethodOf,
} from "../../src/http/guards.ts";
import { recordingLoggers } from "../helpers/harness.ts";

function postRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("readJsonBody", () => {
  it("returns undefined for a non-POST request", async () => {
    expect(await readJsonBody(new Request("http://x/mcp"), 100)).toEqual({
      body: undefined,
      bytes: 0,
    });
  });

  it("parses a well-formed JSON body", async () => {
    expect(await readJsonBody(postRequest('{"a":1}'), 1000)).toEqual({
      body: { a: 1 },
      bytes: 7,
    });
  });

  it("rejects invalid JSON, and records why at debug", async () => {
    const logs = recordingLoggers();
    await expect(readJsonBody(postRequest("not json"), 1000, logs.loggers.log)).rejects.toThrow(
      /not valid JSON/,
    );
    expect(logs.one("http.body.rejected").fields).toMatchObject({
      reason: "not_json",
      limit: 1000,
    });
    expect(logs.one("http.body.rejected").level).toBe("debug");
  });

  it("records an oversized body as its own reason", async () => {
    const logs = recordingLoggers();
    await expect(
      readJsonBody(postRequest("{}", { "content-length": "999999" }), 10, logs.loggers.log),
    ).rejects.toThrow(/exceeds/);
    expect(logs.one("http.body.rejected").fields).toMatchObject({
      reason: "oversized",
      limit: 10,
    });
  });

  it("reports an empty POST body as zero bytes parsed to nothing", async () => {
    expect(await readJsonBody(postRequest("   "), 1000)).toEqual({ body: undefined, bytes: 3 });
  });

  it("bounds by UTF-8 byte length, not UTF-16 code units", async () => {
    const cjk = "字".repeat(20);
    const byteLength = Buffer.byteLength(cjk, "utf8");
    expect(byteLength).toBeGreaterThan(cjk.length);

    await expect(readJsonBody(postRequest(cjk), cjk.length)).rejects.toThrow(/exceeds/);
    await expect(readJsonBody(postRequest(cjk), byteLength)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a body whose declared content-length exceeds the cap", async () => {
    await expect(
      readJsonBody(postRequest("{}", { "content-length": "999999" }), 10),
    ).rejects.toThrow(/exceeds/);
  });

  it("stops a chunked stream as soon as observed bytes cross the cap", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(8));
        if (pulls === 10) controller.close();
      },
    });
    const request = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      body,
      // Required by Node's Request implementation; ignored by Bun.
      duplex: "half",
    } as RequestInit);

    expect(await readBoundedBodyText(request, 10)).toBeNull();
    expect(pulls).toBeLessThan(10);
  });

  it("still rejects an oversized stream when cancelling its producer fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        throw new Error("producer cancellation failed");
      },
    });
    const request = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);

    expect(await readBoundedBodyText(request, 10)).toBeNull();
  });
});

describe("checkOriginAndHost", () => {
  it("passes through when no allow-lists are configured", () => {
    const req = new Request("http://x/mcp", { headers: { origin: "https://evil.example" } });
    expect(
      checkOriginAndHost(req, { allowedOrigins: [], allowedHosts: [], maxBodyBytes: 100 }),
    ).toBeUndefined();
  });

  it("rejects an origin not on the allow-list, naming the value it refused", () => {
    const logs = recordingLoggers();
    const req = new Request("http://x/mcp", { headers: { origin: "https://evil.example" } });
    const res = checkOriginAndHost(
      req,
      { allowedOrigins: ["https://good.example"], allowedHosts: [], maxBodyBytes: 100 },
      logs.loggers.log,
    );
    expect(res?.status).toBe(403);
    expect(logs.one("http.guard.blocked").fields).toMatchObject({
      reason: "origin",
      value: "https://evil.example",
    });
  });

  it("rejects a host not on the allow-list, naming the value it refused", () => {
    const logs = recordingLoggers();
    const req = new Request("http://evil.example/mcp", { headers: { host: "evil.example" } });
    const res = checkOriginAndHost(
      req,
      { allowedOrigins: [], allowedHosts: ["good.example"], maxBodyBytes: 100 },
      logs.loggers.log,
    );
    expect(res?.status).toBe(403);
    expect(logs.one("http.guard.blocked").fields).toMatchObject({
      reason: "host",
      value: "evil.example",
    });
  });
});

describe("rpcMethodOf", () => {
  it("names the single method a request carries", () => {
    expect(rpcMethodOf({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toBe("tools/call");
  });

  // One field, one value: a request log line answers "which method" and a batch
  // is still one request. The sink would carry an array (specs/cross-cutting/observability.md
  // 3.1), but nothing downstream wants to filter on a batch member.
  it("joins a batch into one field, because a batch is still one request", () => {
    expect(rpcMethodOf([{ method: "initialize" }, { method: "tools/list" }])).toBe(
      "initialize,tools/list",
    );
  });

  it("names nothing for a body that is not a JSON-RPC request", () => {
    expect(rpcMethodOf(undefined)).toBeUndefined();
    expect(rpcMethodOf({ id: 1 })).toBeUndefined();
    expect(rpcMethodOf({ method: 7 })).toBeUndefined();
  });

  // The field is set before authentication, from a body no schema has seen, and
  // the default CLARVIS_SERVER_LOG_REQUESTS=errors posture records the 400 a
  // session-less batch earns. An uncapped join let an anonymous caller size an
  // operator's log line: a 4 MiB body of {"method":"x"} is ~260k entries.
  it("caps how many of a batch's methods it names, and says it did", () => {
    const field = rpcMethodOf(Array.from({ length: 260_000 }, () => ({ method: "x" })));
    expect(field).toBe("x,x,x,x,[+259996 more]");
    expect(field!.length).toBeLessThan(100);
  });

  it("caps one absurdly long method name, and says it did", () => {
    const field = rpcMethodOf({ method: "z".repeat(4096) });
    expect(field).toBe(`${"z".repeat(64)}[+4032 chars]`);
  });

  it("leaves a batch at the cap unmarked", () => {
    expect(rpcMethodOf([{ method: "a" }, { method: "b" }, { method: "c" }, { method: "d" }])).toBe(
      "a,b,c,d",
    );
  });
});

describe("isInitializeBody", () => {
  it("recognizes a bare initialize request", () => {
    expect(isInitializeBody({ jsonrpc: "2.0", id: 1, method: "initialize" })).toBe(true);
  });

  it("recognizes initialize inside a batch", () => {
    expect(isInitializeBody([{ method: "tools/list" }, { method: "initialize" }])).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isInitializeBody({ method: "tools/list" })).toBe(false);
    expect(isInitializeBody(undefined)).toBe(false);
    expect(isInitializeBody("initialize")).toBe(false);
  });
});
