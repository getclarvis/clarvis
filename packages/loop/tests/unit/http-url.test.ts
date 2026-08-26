import { describe, it, expect } from "../bun-test.ts";
import { isWellFormedHttpUrl } from "../../src/http-url.ts";

describe("isWellFormedHttpUrl", () => {
  it("accepts http/https and rejects the rest", () => {
    expect(isWellFormedHttpUrl("https://a.b/v1")).toBe(true);
    expect(isWellFormedHttpUrl("http://localhost:1/v1")).toBe(true);
    expect(isWellFormedHttpUrl("ftp://x")).toBe(false);
    expect(isWellFormedHttpUrl("not a url")).toBe(false);
  });
});
