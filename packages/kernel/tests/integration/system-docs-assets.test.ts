import { expect, test } from "bun:test";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = fileURLToPath(
  new URL("../../assets/skills/.system/clarvis-docs/", import.meta.url),
);

test("shipped configuration skill is a self-contained Markdown tree", async () => {
  const manifest = await readFile(join(skillDir, "SKILL.md"), "utf8");
  expect(manifest).toContain("name: clarvis-docs");
  expect(manifest).toContain("user-invocable: false");

  const references = (await readdir(join(skillDir, "references"))).sort();
  expect(references).toEqual([
    "authority.md",
    "extensions.md",
    "paths.md",
    "settings.md",
    "troubleshooting.md",
  ]);
  const pages = [
    { name: "SKILL.md", body: manifest },
    ...(await Promise.all(
      references.map(async (name) => ({
        name: `references/${name}`,
        body: await readFile(join(skillDir, "references", name), "utf8"),
      })),
    )),
  ];
  for (const page of pages) {
    expect(page.body.length).toBeGreaterThan(0);
    expect((await stat(join(skillDir, page.name))).size).toBeLessThan(50_000);
    expect(page.body).not.toMatch(/(?:packages|specs|tooling)\/[A-Za-z0-9_./-]+/);
    expect(page.body).not.toContain("Source pointers:");
  }
  for (const name of references) expect(manifest).toContain(`references/${name}`);
});
