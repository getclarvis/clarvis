import { describe, expect, it } from "../bun-test.ts";
import { defaultGuardMode } from "../../src/runtime/capabilities/tools-settings.ts";

describe("defaultGuardMode", () => {
  it("defaults an absent or mode-less guard to on and preserves an explicit mode", () => {
    expect(defaultGuardMode(undefined)).toBe("on");
    expect(defaultGuardMode({ type: "shell" })).toBe("on");
    expect(defaultGuardMode({ type: "shell", mode: "off" })).toBe("off");
  });
});
