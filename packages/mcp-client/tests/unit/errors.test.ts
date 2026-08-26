import { describe, expect, it } from "bun:test";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isMcpProtocolError, isMcpRequestTimeout } from "../../src/errors.ts";

describe("MCP error classification", () => {
  it("recognizes only the request-timeout code as a timeout", () => {
    expect(isMcpRequestTimeout({ code: ErrorCode.RequestTimeout })).toBe(true);
    expect(isMcpRequestTimeout({ code: ErrorCode.InternalError })).toBe(false);
    expect(isMcpRequestTimeout({ code: String(ErrorCode.RequestTimeout) })).toBe(false);
    expect(isMcpRequestTimeout(null)).toBe(false);
    expect(isMcpRequestTimeout("timeout")).toBe(false);
  });

  it.each([
    ErrorCode.InvalidRequest,
    ErrorCode.MethodNotFound,
    ErrorCode.InvalidParams,
    ErrorCode.InternalError,
    ErrorCode.ParseError,
  ])("recognizes protocol error code %d", (code) => {
    expect(isMcpProtocolError({ code })).toBe(true);
  });

  it("does not classify timeouts, transport failures, or malformed values as protocol errors", () => {
    expect(isMcpProtocolError({ code: ErrorCode.RequestTimeout })).toBe(false);
    expect(isMcpProtocolError({ code: 123_456 })).toBe(false);
    expect(isMcpProtocolError({ code: String(ErrorCode.InvalidParams) })).toBe(false);
    expect(isMcpProtocolError(new Error("socket closed"))).toBe(false);
    expect(isMcpProtocolError(null)).toBe(false);
    expect(isMcpProtocolError("invalid request")).toBe(false);
  });
});
