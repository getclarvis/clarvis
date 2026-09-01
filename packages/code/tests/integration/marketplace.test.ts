import { afterEach, describe, expect, it, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentsMarketplaceFile, WORKSPACE_ENV } from "@clarvis/paths";
import { withoutGitRepositoryEnvironment } from "@clarvis/kernel/local";
import {
  addMarketplaceSource,
  createMarketplaceAdapter,
  marketplaceInstallSource,
  OFFICIAL_MARKETPLACE_URL,
  type MarketplaceListing,
} from "../../src/adapters/marketplace.ts";
import { recordDiagnostics } from "../helpers/recording-diagnostics.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/**
 * Build the adapter with cross-runtime discovery switched off unless a test asks
 * for it, so no suite ever reads the developer's own home.
 */
function adapter(deps: {
  urls: () => string[];
  installed: () => string[];
  agentsCatalogs?: () => string[];
}): ReturnType<typeof createMarketplaceAdapter> {
  return createMarketplaceAdapter({ agentsCatalogs: () => [], defaultUrls: [], ...deps });
}

function runGit(repo: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: withoutGitRepositoryEnvironment(process.env),
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function marketplaceRepo(body: unknown, name = "market"): string {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-"));
  roots.push(dir);
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  if (body !== null) {
    writeFileSync(
      join(repo, "marketplace.json"),
      typeof body === "string" ? body : JSON.stringify(body, null, 2),
    );
  }
  writeFileSync(join(repo, "README.md"), "x");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
    ["add", "-A"],
    ["commit", "-qm", "init"],
  ]) {
    runGit(repo, ...args);
  }
  return `file://${repo}`;
}

const CATALOG = {
  name: "clarvis community",
  description: "Community plugins.",
  plugins: [
    { name: "reviewkit", source: "https://github.com/o/reviewkit", description: "Review helpers." },
    { name: "docs", source: "https://github.com/o/docs", description: "Doc helpers." },
  ],
};

test("sources: includes the official marketplace first and only once", () => {
  const added = "https://example.invalid/extra.git";
  const a = createMarketplaceAdapter({
    urls: () => [OFFICIAL_MARKETPLACE_URL, added],
    installed: () => [],
    agentsCatalogs: () => [],
  });
  expect(a.sources().map((source) => source.url)).toEqual([OFFICIAL_MARKETPLACE_URL, added]);
  expect(a.listings()).toEqual([]);
});

test("listings: reads a marketplace over git and sorts by plugin name", async () => {
  const url = marketplaceRepo(CATALOG);
  const a = adapter({ urls: () => [url], installed: () => [] });
  await a.load();
  expect(a.listings().map((l) => l.name)).toEqual(["docs", "reviewkit"]);
  expect(a.listings()[0]!.marketplace).toBe("clarvis community");
  expect(a.listings()[0]!.installed).toBe(false);
});

test("listings: carries the subdir path so a same-repo plugin installs from it", async () => {
  const url = marketplaceRepo({
    name: "mono",
    plugins: [
      {
        name: "brainstorm",
        source: "https://h/mono",
        path: "plugins/brainstorm",
        description: "b",
      },
    ],
  });
  const a = adapter({ urls: () => [url], installed: () => [] });
  await a.load();
  expect(a.listings()[0]!.path).toBe("plugins/brainstorm");
});

test("listings: rewrites an installable repository-local source into that repository and subdir", async () => {
  const url = marketplaceRepo({
    name: "mono",
    plugins: [
      {
        name: "brainstorm",
        source: { source: "local", path: "plugins/brainstorm" },
        description: "b",
      },
    ],
  });
  const repo = url.replace("file://", "");
  mkdirSync(join(repo, "plugins", "brainstorm"), { recursive: true });
  writeFileSync(join(repo, "plugins", "brainstorm", "README.md"), "plugin");
  runGit(repo, "add", "-A");
  runGit(repo, "commit", "-qm", "plugin");

  const a = adapter({ urls: () => [url], installed: () => [] });
  await a.load();
  expect(a.listings()[0]).toMatchObject({
    sourceType: "git",
    source: url,
    path: "plugins/brainstorm",
    installable: true,
  });
});

test("marketplaceInstallSource projects local, npm, and pinned git inventory targets", () => {
  expect(
    marketplaceInstallSource({
      sourceType: "local",
      source: "/plugins/local",
    } as MarketplaceListing),
  ).toEqual({ kind: "local", path: "/plugins/local" });
  expect(
    marketplaceInstallSource({
      sourceType: "npm",
      source: "@scope/plugin",
      version: "1.2.3",
      registry: "https://registry.npmjs.org",
    } as MarketplaceListing),
  ).toEqual({
    kind: "npm",
    package: "@scope/plugin",
    version: "1.2.3",
    registry: "https://registry.npmjs.org",
  });
  expect(
    marketplaceInstallSource({
      sourceType: "git",
      source: "https://example.invalid/plugin.git",
      path: "plugins/demo",
      ref: "main",
      sha: "abc123",
    } as MarketplaceListing),
  ).toEqual({
    kind: "git",
    url: "https://example.invalid/plugin.git",
    subdir: "plugins/demo",
    ref: "main",
    sha: "abc123",
  });
});

test("listings: flags what is already installed", async () => {
  const url = marketplaceRepo(CATALOG);
  const a = adapter({ urls: () => [url], installed: () => ["reviewkit"] });
  await a.load();
  const byName = new Map(a.listings().map((l) => [l.name, l]));
  expect(byName.get("reviewkit")!.installed).toBe(true);
  expect(byName.get("docs")!.installed).toBe(false);
});

test("sources: surfaces a repo with no marketplace.json instead of failing the whole view", async () => {
  const good = marketplaceRepo(CATALOG);
  const bad = marketplaceRepo(null, "not-a-market");
  const a = adapter({ urls: () => [bad, good], installed: () => [] });
  await a.load();
  const sources = a.sources();
  expect(sources[0]!.error).toContain("no marketplace.json");
  expect(sources[1]!.marketplace?.name).toBe("clarvis community");
  expect(a.listings().map((l) => l.name)).toEqual(["docs", "reviewkit"]);
});

test("sources: an unusable listing is dropped and noted, and the catalog still loads", async () => {
  const url = marketplaceRepo({ name: "x", plugins: [{ name: "y" }] });
  const a = adapter({ urls: () => [url], installed: () => [] });
  await a.load();
  expect(a.sources()[0]!.error).toBeUndefined();
  expect(a.sources()[0]!.marketplace!.notes.join(" ")).toContain("was dropped");
  expect(a.listings()).toEqual([]);
});

test("sources: a document that is not an object at all is still an error", async () => {
  const url = marketplaceRepo("[1, 2, 3]");
  const a = adapter({ urls: () => [url], installed: () => [] });
  await a.load();
  expect(a.sources()[0]!.error).toContain("invalid");
});

test("sources: surfaces malformed JSON", async () => {
  const url = marketplaceRepo("{ not json");
  const a = adapter({ urls: () => [url], installed: () => [] });
  await a.load();
  expect(a.sources()[0]!.error).toContain("not valid JSON");
});

test("sources: a bad marketplace URL is reported, never handed to git", async () => {
  const a = adapter({ urls: () => ["ext::sh -c whoami"], installed: () => [] });
  await a.load();
  expect(a.sources()[0]!.error).toContain("ext:: transport");
});

test("sources: a not-yet-loaded url reads as pending, not an error", () => {
  const url = marketplaceRepo(CATALOG);
  const a = adapter({ urls: () => [url], installed: () => [] });
  const s = a.sources()[0]!;
  expect(s.marketplace).toBeUndefined();
  expect(s.error).toBeUndefined();
});

test("load: caches a success, retries an error, and refresh re-reads everything", async () => {
  const url = marketplaceRepo(CATALOG);
  const a = adapter({ urls: () => [url], installed: () => [] });
  await a.load();
  expect(a.listings()).toHaveLength(2);
  const repo = url.replace("file://", "");
  writeFileSync(join(repo, "marketplace.json"), JSON.stringify({ name: "m", plugins: [] }));
  runGit(repo, "add", "-A");
  runGit(repo, "commit", "-qm", "empty");
  await a.load();
  expect(a.listings()).toHaveLength(2);
  a.refresh();
  await a.load();
  expect(a.listings()).toHaveLength(0);
});

test("listings: two marketplaces both offering a name keep both rows, tagged by marketplace", async () => {
  const one = marketplaceRepo(CATALOG, "one");
  const two = marketplaceRepo(
    { name: "other market", plugins: [{ ...CATALOG.plugins[0]!, source: "https://elsewhere/x" }] },
    "two",
  );
  const a = adapter({ urls: () => [one, two], installed: () => [] });
  await a.load();
  const reviewkits = a.listings().filter((l) => l.name === "reviewkit");
  expect(reviewkits).toHaveLength(2);
  expect(reviewkits.map((l) => l.marketplace).sort()).toEqual([
    "clarvis community",
    "other market",
  ]);
});

test("listings: two marketplaces that share a display name still both show (dedup is by URL)", async () => {
  const one = marketplaceRepo(CATALOG, "one");
  const two = marketplaceRepo(
    { ...CATALOG, plugins: [{ ...CATALOG.plugins[0]!, source: "https://elsewhere/x" }] },
    "two",
  );
  const a = adapter({ urls: () => [one, two], installed: () => [] });
  await a.load();
  expect(a.listings().filter((l) => l.name === "reviewkit")).toHaveLength(2);
});

/** Write a marketplace document at the cross-runtime location under `root`. */
function agentsCatalog(root: string, body: unknown): string {
  const file = agentsMarketplaceFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return file;
}

/** A throwaway directory, removed with the rest after the test. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-catalog-"));
  roots.push(dir);
  return dir;
}

test("agents catalogs: a cross-runtime document is read as a source of its own", async () => {
  const home = scratch();
  const file = agentsCatalog(home, CATALOG);
  const a = adapter({ urls: () => [], installed: () => [], agentsCatalogs: () => [file] });
  await a.load();
  expect(a.listings().map((l) => l.name)).toEqual(["docs", "reviewkit"]);
  expect(a.sources()[0]!.url).toBe(file);
});

test("agents catalogs: both scopes contribute, workspace first", async () => {
  const home = scratch();
  const workspace = scratch();
  const userFile = agentsCatalog(home, { name: "user market", plugins: [] });
  const workspaceFile = agentsCatalog(workspace, { name: "workspace market", plugins: [] });
  const a = adapter({
    urls: () => [],
    installed: () => [],
    agentsCatalogs: () => [workspaceFile, userFile],
  });
  await a.load();
  expect(a.sources().map((s) => s.marketplace?.name)).toEqual(["workspace market", "user market"]);
});

test("agents catalogs: discovery reads both scopes and skips the ones that are absent", async () => {
  const home = scratch();
  const workspace = scratch();
  agentsCatalog(workspace, { name: "workspace market", plugins: [] });
  const previousHome = process.env.HOME;
  const previousWorkspace = process.env[WORKSPACE_ENV];
  process.env.HOME = home;
  process.env[WORKSPACE_ENV] = workspace;
  try {
    const a = createMarketplaceAdapter({
      urls: () => [],
      installed: () => [],
      defaultUrls: [],
    });
    await a.load();
    expect(a.sources().map((s) => s.marketplace?.name)).toEqual(["workspace market"]);
    a.refresh();
    expect(a.sources()).toEqual([]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousWorkspace === undefined) delete process.env[WORKSPACE_ENV];
    else process.env[WORKSPACE_ENV] = previousWorkspace;
  }
});

test("agents catalogs: an unreadable document is reported as that source's error alone", async () => {
  const home = scratch();
  const good = agentsCatalog(scratch(), CATALOG);
  const missing = agentsMarketplaceFile(home);
  const a = adapter({
    urls: () => [],
    installed: () => [],
    agentsCatalogs: () => [missing, good],
  });
  await a.load();
  expect(a.sources()[0]!.error).toContain("could not be read");
  expect(a.listings().map((l) => l.name)).toEqual(["docs", "reviewkit"]);
});

test("a repo's own document outranks the cross-runtime one it also publishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-"));
  roots.push(dir);
  const repo = join(dir, "both");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "marketplace.json"), JSON.stringify({ name: "root", plugins: [] }));
  agentsCatalog(repo, { name: "borrowed", plugins: [] });
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
    ["add", "-A"],
    ["commit", "-qm", "init"],
  ]) {
    runGit(repo, ...args);
  }
  const a = adapter({ urls: () => [`file://${repo}`], installed: () => [] });
  await a.load();
  expect(a.sources()[0]!.marketplace?.name).toBe("root");
});

test("a repo publishing only the cross-runtime document is still read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-"));
  roots.push(dir);
  const repo = join(dir, "borrowed-only");
  mkdirSync(repo, { recursive: true });
  agentsCatalog(repo, { name: "borrowed", plugins: [] });
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "t"],
    ["add", "-A"],
    ["commit", "-qm", "init"],
  ]) {
    runGit(repo, ...args);
  }
  const a = adapter({ urls: () => [`file://${repo}`], installed: () => [] });
  await a.load();
  expect(a.sources()[0]!.marketplace?.name).toBe("borrowed");
});

test("a local source resolving outside the marketplace root is named, after realpath", async () => {
  const root = scratch();
  const outside = scratch();
  const file = agentsCatalog(root, {
    name: "local market",
    plugins: [
      { name: "inside", source: { source: "local", path: "plugins/inside" }, description: "d" },
      { name: "escapee", source: { source: "local", path: "plugins/escapee" }, description: "d" },
      { name: "ghost", source: { source: "local", path: "plugins/ghost" }, description: "d" },
    ],
  });
  const plugins = join(root, "plugins");
  mkdirSync(join(plugins, "inside"), { recursive: true });
  symlinkSync(outside, join(plugins, "escapee"), "dir");
  const a = adapter({ urls: () => [], installed: () => [], agentsCatalogs: () => [file] });
  const recording = recordDiagnostics();
  try {
    await a.load();
  } finally {
    recording.uninstall();
  }
  const byName = new Map(a.listings().map((l) => [l.name, l]));
  expect(byName.get("escapee")!.notes.join(" ")).toContain("outside the marketplace root");
  expect(byName.get("inside")!.notes.join(" ")).not.toContain("outside the marketplace root");
  expect(byName.get("inside")!.installable).toBe(true);
  expect(byName.get("inside")!.source).toBe(join(root, "plugins", "inside"));
  // A path that does not exist yet is the case the "contained" answer was
  // written for, and it is not a diagnostic: there is nothing to escape into.
  expect(byName.get("ghost")!.notes.join(" ")).not.toContain("outside the marketplace root");
  expect(recording.of("marketplace.containment.unknown")).toHaveLength(0);
});

test("a local source whose containment cannot be decided is refused, not assumed contained", async () => {
  const root = scratch();
  const file = agentsCatalog(root, {
    name: "local market",
    plugins: [
      { name: "cycle", source: { source: "local", path: "plugins/cycle" }, description: "d" },
    ],
  });
  const plugins = join(root, "plugins");
  mkdirSync(plugins, { recursive: true });
  // A symlink cycle makes realpath fail ELOOP. The target comes from the
  // marketplace document, so its author can produce this at will — which is
  // exactly why answering "contained" here let them suppress the note about
  // their own listing.
  symlinkSync(join(plugins, "cycle-b"), join(plugins, "cycle"));
  symlinkSync(join(plugins, "cycle"), join(plugins, "cycle-b"));

  const a = adapter({ urls: () => [], installed: () => [], agentsCatalogs: () => [file] });
  const recording = recordDiagnostics();
  try {
    await a.load();
  } finally {
    recording.uninstall();
  }

  const listing = a.listings().find((l) => l.name === "cycle")!;
  expect(listing.notes.join(" ")).toContain("outside the marketplace root");
  expect(listing.installable).toBe(false);

  const unknown = recording.of("marketplace.containment.unknown");
  expect(unknown).toHaveLength(1);
  expect(unknown[0]!.level).toBe("warn");
  expect(unknown[0]!.details.errno).toBe("ELOOP");
});

describe("addMarketplaceSource", () => {
  function settingsStub(initial: string[] | undefined) {
    const writes: { scope: string; patch: unknown }[] = [];
    return {
      writes,
      adapter: {
        read: (_scope: string) => (initial === undefined ? {} : { marketplaces: initial }),
        write: async (scope: string, patch: unknown) => {
          writes.push({ scope, patch });
        },
      },
    };
  }

  it("appends a new URL to the global list", async () => {
    const s = settingsStub(["https://example.invalid/a.git"]);
    const result = await addMarketplaceSource(s.adapter as never, "https://example.invalid/b.git");
    expect(result.added).toBe(true);
    expect(result.message).toContain("https://example.invalid/b.git");
    expect(s.writes).toEqual([
      {
        scope: "global",
        patch: {
          marketplaces: ["https://example.invalid/a.git", "https://example.invalid/b.git"],
        },
      },
    ]);
  });

  it("starts the list when settings carry none", async () => {
    const s = settingsStub(undefined);
    await addMarketplaceSource(s.adapter as never, "https://example.invalid/only.git");
    expect(s.writes[0]?.patch).toEqual({ marketplaces: ["https://example.invalid/only.git"] });
  });

  it("writes nothing when the URL is already configured", async () => {
    const s = settingsStub(["https://example.invalid/a.git"]);
    const result = await addMarketplaceSource(s.adapter as never, "https://example.invalid/a.git");
    expect(result.added).toBe(false);
    expect(result.message).toContain("already configured");
    expect(s.writes).toEqual([]);
  });

  it("does not persist the marketplace Clarvis already includes", async () => {
    const s = settingsStub(undefined);
    const result = await addMarketplaceSource(s.adapter as never, OFFICIAL_MARKETPLACE_URL);
    expect(result.added).toBe(false);
    expect(result.message).toContain("available by default");
    expect(s.writes).toEqual([]);
  });
});
