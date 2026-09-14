import { describe, expect, spyOn, test } from "bun:test";
import { openPublicUrl } from "../../src/adapters/open-public-url.ts";

describe("openPublicUrl", () => {
  test("rejects malformed and non-HTTP destinations before spawning a browser", async () => {
    await expect(openPublicUrl("not a URL")).resolves.toBe(false);
    await expect(openPublicUrl("file:///tmp/private")).resolves.toBe(false);
    await expect(openPublicUrl("javascript:alert(1)")).resolves.toBe(false);
  });

  test("reports browser process refusal and spawn failure without throwing", async () => {
    const spawn = spyOn(Bun, "spawn");
    try {
      spawn.mockImplementation(
        () => ({ exited: Promise.resolve(1) }) as ReturnType<typeof Bun.spawn>,
      );
      await expect(openPublicUrl("https://example.com/path")).resolves.toBe(false);
      spawn.mockImplementation(() => {
        throw new Error("browser unavailable");
      });
      await expect(openPublicUrl("http://example.com/")).resolves.toBe(false);
    } finally {
      spawn.mockRestore();
    }
  });
});
