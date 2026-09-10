import { describe, expect, test } from "bun:test";
import {
  encodeRemoteKernelArguments,
  parseRemoteKernelArguments,
} from "../../src/adapters/remote-kernel-arguments.ts";

describe("remote kernel launch arguments", () => {
  test("round trips a path and selector through one shell-safe token", () => {
    const encoded = encodeRemoteKernelArguments({
      workspaceRoot: "/srv/work space/repository",
      extensionProfileSelector: "global:remote profile",
    });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseRemoteKernelArguments(["--remote-kernel", encoded])).toEqual({
      workspaceRoot: "/srv/work space/repository",
      extensionProfileSelector: "global:remote profile",
    });
  });

  test("rejects relative paths, extra fields and malformed encodings", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(() =>
      parseRemoteKernelArguments(["--remote-kernel", encode({ workspaceRoot: "relative" })]),
    ).toThrow("invalid");
    expect(() =>
      parseRemoteKernelArguments([
        "--remote-kernel",
        encode({ workspaceRoot: "/workspace", owner: "forged" }),
      ]),
    ).toThrow("invalid");
    expect(() => parseRemoteKernelArguments(["--remote-kernel", "bad!"])).toThrow("invalid");
  });
});
