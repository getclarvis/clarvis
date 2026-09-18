import { describe, expect, test } from "bun:test";

import {
  CodedError,
  ConflictError,
  ContinuationUnavailableError,
  executionIdConflict,
  PersistenceError,
  ModelCallInactivityError,
  ProviderError,
  ValidationError,
} from "../../src/index.ts";

test("model inactivity shares the provider error contract and preserves known usage", () => {
  const usage = { input_tokens: 10, output_tokens: 2, cached_tokens: 0, cache_write_tokens: 0 };
  const error = new ModelCallInactivityError(180000, true, usage);
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.kind).toBe("transient");
  expect(error.streamStarted).toBe(true);
  expect(error.partialUsage).toBe(usage);
  expect(error.name).toBe("ModelCallInactivityError");
  expect(new ModelCallInactivityError(180000, false).partialUsage).toBeUndefined();
});

describe("CodedError", () => {
  test("reports the concrete subclass's own name, not the base's", () => {
    expect(new PersistenceError().name).toBe("PersistenceError");
    expect(new ConflictError("x").name).toBe("ConflictError");
    expect(new ValidationError("invalid_message_format", "x").name).toBe("ValidationError");
  });

  test("every subclass is still an Error, so a bare catch reaches it", () => {
    const err = new PersistenceError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CodedError);
  });

  test("leaves details undefined when none are supplied", () => {
    expect(new ConflictError("clash").details).toBeUndefined();
    expect(new PersistenceError().details).toBeUndefined();
  });

  test("stores details when supplied", () => {
    expect(new ConflictError("clash", { execution_id: "e1" }).details).toEqual({
      execution_id: "e1",
    });
  });
});

describe("ValidationError", () => {
  test("carries the caller-supplied code, so the rule is machine-identifiable", () => {
    const err = new ValidationError("invalid_message_format", "bad message", { field: "messages" });
    expect(err.code).toBe("invalid_message_format");
    expect(err.message).toBe("bad message");
    expect(err.details).toEqual({ field: "messages" });
  });
});

describe("ConflictError and PersistenceError", () => {
  test("pin their discriminators, which callers switch on", () => {
    expect(new ConflictError("x").code).toBe("execution_id_conflict");
    expect(new PersistenceError().code).toBe("persistence_failure");
  });

  test("PersistenceError has a default message and accepts an override", () => {
    expect(new PersistenceError().message).toBe("Failed to persist execution.");
    expect(new PersistenceError("disk full", { path: "/x" }).message).toBe("disk full");
    expect(new PersistenceError("disk full", { path: "/x" }).details).toEqual({ path: "/x" });
  });
});

describe("executionIdConflict", () => {
  test("builds a ConflictError naming the id in both message and details", () => {
    const err = executionIdConflict("exec_1");
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe("execution_id_conflict");
    expect(err.message).toContain("exec_1");
    expect(err.details).toEqual({ execution_id: "exec_1" });
  });
});

describe("ContinuationUnavailableError", () => {
  test("echoes the unresolvable id and directs the caller to the recovery", () => {
    const err = new ContinuationUnavailableError("exec_gone");
    expect(err.code).toBe("continuation_unavailable");
    expect(err.message).toContain("exec_gone");
    expect(err.message).toContain("full message history");
    expect(err.details).toEqual({ continue_from: "exec_gone" });
  });
});
