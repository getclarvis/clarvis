import { describe, expect, it } from "../bun-test.ts";
import {
  nonnegativeIntField,
  positiveIntField,
} from "../../src/validation/request/numeric-schemas.ts";

describe("request numeric schemas", () => {
  it.each([
    [positiveIntField("limit"), 1, true],
    [positiveIntField("limit"), 0, false],
    [positiveIntField("limit"), -1, false],
    [positiveIntField("limit"), 1.5, false],
    [nonnegativeIntField("count"), 0, true],
    [nonnegativeIntField("count"), 1, true],
    [nonnegativeIntField("count"), -1, false],
    [nonnegativeIntField("count"), 1.5, false],
  ])("parses integer boundary %#", (schema, value, success) => {
    expect(schema.safeParse(value).success).toBe(success);
  });
});
