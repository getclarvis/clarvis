import { expect, it, vi } from "bun:test";
import { warn } from "#src/lib/log.ts";

it("writes warnings to the process stderr channel by default", () => {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    warn("a message\n");
    expect(spy).toHaveBeenCalledWith("a message\n");
  } finally {
    spy.mockRestore();
  }
});
