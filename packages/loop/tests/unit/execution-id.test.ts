import { describe, it, expect } from "../bun-test.ts";
import {
  EXECUTION_ID_PATTERN,
  EXECUTION_ID_MIN,
  EXECUTION_ID_MAX,
} from "../../src/types/execution-id.ts";
import { generateExecutionId } from "@clarvis/trace";

const matchesFormat = (id: string): boolean =>
  id.length >= EXECUTION_ID_MIN && id.length <= EXECUTION_ID_MAX && EXECUTION_ID_PATTERN.test(id);

describe("execution-id format constants", () => {
  it("accept the allowed charset [A-Za-z0-9._:-]", () => {
    expect(matchesFormat("my-app.task_001:v2")).toBe(true);
    expect(matchesFormat("ABCxyz0189")).toBe(true);
  });

  it("reject an empty id", () => {
    expect(matchesFormat("")).toBe(false);
  });

  it("accept exactly 128 chars and reject 129", () => {
    expect(matchesFormat("a".repeat(EXECUTION_ID_MAX))).toBe(true);
    expect(matchesFormat("a".repeat(EXECUTION_ID_MAX + 1))).toBe(false);
  });

  it("reject disallowed characters", () => {
    expect(matchesFormat("has space")).toBe(false);
    expect(matchesFormat("slash/here")).toBe(false);
    expect(matchesFormat("emoji😀")).toBe(false);
    expect(matchesFormat("comma,sep")).toBe(false);
  });
});

describe("execution-id generation", () => {
  it("prefixes generated ids with exec_ and matches the format", () => {
    const id = generateExecutionId();
    expect(id.startsWith("exec_")).toBe(true);
    expect(matchesFormat(id)).toBe(true);
  });

  it("generates distinct ids", () => {
    expect(generateExecutionId()).not.toBe(generateExecutionId());
  });
});
