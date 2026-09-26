import { expect, test } from "../bun-test.ts";
import {
  temporaryRootsForExecution,
  type AgentExecutionBinding,
} from "../../src/runtime/capabilities/tools.ts";

test("sandbox workers receive only mounted temporary roots", () => {
  const roots = ["/run/user/1000/private-tmp", "/tmp", "/private/tmp"];
  const sandbox: AgentExecutionBinding = {
    executionPolicy: {} as NonNullable<AgentExecutionBinding["executionPolicy"]>,
  };
  expect(temporaryRootsForExecution("/tmp/clarvis-run", sandbox, roots)).toEqual([
    "/tmp/clarvis-run",
    "/tmp",
  ]);
  const seatbelt: AgentExecutionBinding = {
    ...sandbox,
    sandboxBackend: { name: "seatbelt" } as NonNullable<AgentExecutionBinding["sandboxBackend"]>,
  };
  expect(temporaryRootsForExecution("/tmp/clarvis-run", seatbelt, roots)).toEqual([
    "/tmp/clarvis-run",
    "/tmp",
    "/private/tmp",
  ]);
  expect(temporaryRootsForExecution("/tmp/clarvis-run", {}, roots)).toEqual([
    "/tmp/clarvis-run",
    ...roots,
  ]);
});
