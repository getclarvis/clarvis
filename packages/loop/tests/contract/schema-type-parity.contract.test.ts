import { describe, it, expect } from "../bun-test.ts";
import type { RunRequest } from "@clarvis/capability";
import type { ParsedRunRequest } from "../../src/validation/index.ts";

type Extends<A, B> = [A] extends [B] ? true : false;
type Mutual<A, B> = Extends<A, B> extends true ? Extends<B, A> : false;

const requestParity: Mutual<RunRequest, ParsedRunRequest> = true;

describe("schema ↔ type parity", () => {
  it("RunRequest and the zod-inferred ParsedRunRequest stay mutually assignable", () => {
    expect(requestParity).toBe(true);
  });
});
