import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { timeVersion } from "../../tooling/benchmarks/first-paint.ts";

test("first-paint version samples use the benchmark SmokeContext roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-benchmark-isolation-entry-"));
  const entry = join(root, "entry.ts");
  await writeFile(
    entry,
    [
      'import { join } from "node:path";',
      "const values = {",
      "  home: process.env.HOME,",
      "  global: process.env.CLARVIS_HOME,",
      "  workspace: process.env.CLARVIS_WORKSPACE_ROOT,",
      "  temporary: process.env.TMPDIR,",
      "};",
      'await Bun.write(join(process.env.CLARVIS_WORKSPACE_ROOT!, "observed.json"), JSON.stringify(values));',
      'process.stdout.write("clarvis 0.0.0\\n");',
    ].join("\n"),
  );

  try {
    await timeVersion(entry, { CLARVIS_CODE_SOURCE: "1" }, async (context) => {
      const observed = JSON.parse(
        await readFile(join(context.workspace, "observed.json"), "utf8"),
      ) as Record<string, string>;
      expect(observed.home).toBe(context.home);
      expect(observed.global).toBe(context.global);
      expect(observed.workspace).toBe(context.workspace);
      expect(observed.temporary).toBe(context.tmp);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
