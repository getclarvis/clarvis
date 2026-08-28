import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

function fencedBlocks(source: string, language: string): string[] {
  const fence = new RegExp("^```" + language + "\\s*\\n([\\s\\S]*?)^```\\s*$", "gm");
  return [...source.matchAll(fence)].map((match) => match[1].trim());
}

test("keeps the README install commands aligned with the product version", () => {
  const manifest = JSON.parse(read("package.json")) as { version: string };
  const readme = read("README.md");
  expect(fencedBlocks(readme, "bash")[0]).toBe(
    `curl -fsSL https://github.com/getclarvis/clarvis-releases/releases/download/v${manifest.version}/install.sh | sh`,
  );
  expect(fencedBlocks(readme, "powershell")[0]).toBe(
    `irm https://github.com/getclarvis/clarvis-releases/releases/download/v${manifest.version}/install.ps1 | iex`,
  );
});

test("keeps public-site ownership outside this monorepo", () => {
  const manifest = JSON.parse(read("package.json")) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  expect(Object.keys(manifest.scripts ?? {}).filter((name) => name.startsWith("docs:"))).toEqual(
    [],
  );
  expect(manifest.devDependencies?.vitepress).toBeUndefined();
  expect(existsSync(resolve(root, "docs"))).toBe(false);
  expect(existsSync(resolve(root, ".github/workflows/docs.yml"))).toBe(false);

  const workflows = readdirSync(resolve(root, ".github/workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => read(`.github/workflows/${name}`))
    .join("\n");
  expect(workflows).not.toContain("pages: write");
  expect(workflows).not.toContain("actions/configure-pages@");
  expect(workflows).not.toContain("actions/deploy-pages@");

  const readme = read("README.md");
  expect(readme).toContain("https://github.com/getclarvis/docs");
  expect(readme).not.toMatch(/\]\(docs(?:\/|\))/);
  expect(readme).not.toContain("bun run docs:");
});

test("publishes the confidential conduct contact without prelaunch wording", () => {
  const source = read("CODE_OF_CONDUCT.md");
  expect(source).toContain("[hello@clarvis.dev](mailto:hello@clarvis.dev)");
  expect(source).not.toContain("Before the public launch");
});

test("routes GitHub sponsorship to the owner-selected account", () => {
  expect(read(".github/FUNDING.yml")).toBe("github: evandrocabf\n");
});
