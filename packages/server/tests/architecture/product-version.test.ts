import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

const binPath = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
const product = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("server CLI product version", () => {
  it("reports the root-owned version and exits before boot", async () => {
    const child = Bun.spawn([process.execPath, binPath, "--version"], {
      env: { ...globalThis.process.env, CLARVIS_LOG_LEVEL: "silent" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(`${product.version}\n`);
    expect(stderr).toBe("");
  });
});
