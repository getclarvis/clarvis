import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginService, validateGitUrl } from "../../src/plugins/plugin-service.ts";
import { createKernelLifecycle } from "../../src/application/lifecycle.ts";
import type {
  InstalledPlugin,
  PluginFetcher,
  PluginRepository,
} from "../../src/ports/plugin-repository.ts";
import { globalPaths } from "@clarvis/paths";
import { PLUGIN_RESOURCE_LIMITS } from "@clarvis/loop/host";
import { withoutGitRepositoryEnvironment } from "@clarvis/paths";

/** Write a fixture file, creating the scope subdirectory it now lives in. */
/**
 * Install a fixture plugin under `base`'s plugins dir.
 *
 * @param base - a global root, or a workspace *config* dir; `scope` says which.
 *   Only the global scope nests under a lifetime group.
 */
function writePlugin(
  base: string,
  name: string,
  manifest: object | string,
  scope: "global" | "workspace" = "workspace",
): string {
  const root = scope === "global" ? globalPaths(base).pluginsDir : join(base, "plugins");
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "plugin.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  return dir;
}

function writeAgent(dir: string, name: string, frontmatter: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\nbody\n`);
}

function runGit(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: withoutGitRepositoryEnvironment(process.env),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function makeGitRepo(manifest: object): string {
  const repo = mkdtempSync(join(tmpdir(), "clarvis-src-"));
  writeFileSync(join(repo, "plugin.json"), JSON.stringify(manifest));
  runGit(repo, "init", "--quiet");
  runGit(repo, "config", "user.email", "t@t.t");
  runGit(repo, "config", "user.name", "t");
  runGit(repo, "add", "-A");
  runGit(repo, "commit", "--quiet", "-m", "init");
  return repo;
}

function virtualPlugin(
  name: string,
  manifestRaw: string,
  dir = `/virtual/${name}`,
): InstalledPlugin {
  return {
    name,
    scope: "global",
    dir,
    shadowsGlobal: false,
    manifestRaw,
    agentFiles: [],
    gitCheckout: true,
  };
}

describe("PluginService", () => {
  let global: string;
  let workspace: string;
  let enabled: string[];
  function svc() {
    return createPluginService({
      globalDir: global,
      workspaceConfigDir: workspace,
      enabledPlugins: () => enabled,
      environment: process.env,
    });
  }

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-plugins-"));
    global = join(root, "global");
    workspace = join(root, "ws");
    mkdirSync(global, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    enabled = [];
  });
  afterEach(() => {
    rmSync(join(global, ".."), { recursive: true, force: true });
  });

  it("list: reports contributions, enabled state, and broken agents", async () => {
    const p = writePlugin(workspace, "demo", {
      name: "demo",
      version: "1.2.0",
      description: "The demo plugin.",
      mcpServers: { git: { command: "git-mcp" } },
      hooks: [{ event: "pre_tool_use", command: "x" }],
    });
    writeAgent(join(p, "agents"), "good", "model: anthropic/x");
    writeAgent(join(p, "agents"), "bad", "model: NOT-A-MODEL");
    mkdirSync(join(p, "skills", "demo-review"), { recursive: true });
    writeFileSync(
      join(p, "skills", "demo-review", "SKILL.md"),
      "---\nname: demo-review\ndescription: d\n---\n",
    );
    enabled = ["demo"];

    const [view] = await svc().list();
    expect(view!.name).toBe("demo");
    expect(view!.scope).toBe("workspace");
    expect(view!.enabled).toBe(true);
    expect(view!.version).toBe("1.2.0");
    expect(view!.contributions).toEqual({
      agents: ["good"],
      broken_agents: ["bad"],
      skills: ["demo-review"],
      servers: ["demo:git"],
      hooks: 1,
      capability_executables: [],
      executables: ["$ x", "$ demo:git  git-mcp"],
    });
  });

  it("projects every capability executable in sorted capability order", async () => {
    writePlugin(workspace, "services", {
      name: "services",
      capabilityExecutables: {
        plans: { command: "python3", args: ["server.py", "plans"] },
        memory: { command: "python3", args: ["server.py", "memory"] },
      },
    });
    const [view] = await svc().list();
    expect(view!.contributions.capability_executables).toEqual([
      {
        capability: "memory",
        command: "python3",
        args: ["server.py", "memory"],
        platform_override: false,
      },
      {
        capability: "plans",
        command: "python3",
        args: ["server.py", "plans"],
        platform_override: false,
      },
    ]);
  });

  it("list: a workspace plugin shadows a global one of the same name", async () => {
    writePlugin(global, "demo", { name: "demo", version: "1.0.0", description: "g" }, "global");
    writePlugin(workspace, "demo", { name: "demo", version: "2.0.0", description: "w" });
    const views = await svc().list();
    expect(views).toHaveLength(1);
    expect(views[0]!.scope).toBe("workspace");
    expect(views[0]!.shadows_global).toBe(true);
    expect(views[0]!.version).toBe("2.0.0");
  });

  it("list: a broken manifest is surfaced, not hidden", async () => {
    writePlugin(workspace, "bad", "{ not json");
    const [view] = await svc().list();
    expect(view!.error).toContain("invalid JSON");
  });

  it("list: surfaces an excessive agent surface and exposes no partial executables", async () => {
    const dir = writePlugin(workspace, "heavy", {
      name: "heavy",
      mcpServers: { dangerous: { command: "would-run" } },
      hooks: [{ event: "run_start", command: "also-would-run" }],
    });
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "huge.md"), "x");
    truncateSync(join(dir, "agents", "huge.md"), PLUGIN_RESOURCE_LIMITS.agentFileBytes + 1);

    const [view] = await svc().list();
    expect(view!.error).toContain("plugin agents rejected");
    expect(view!.contributions).toMatchObject({
      agents: [],
      broken_agents: [],
      servers: [],
      hooks: 0,
      executables: [],
    });
  });

  it("reviews and approves plugin hooks individually", async () => {
    writePlugin(workspace, "demo", {
      name: "demo",
      hooks: [
        { event: "run_start", command: "one" },
        { event: "run_end", command: "two" },
      ],
    });
    const s = svc();
    const hooks = await s.hooks();
    expect(hooks.map((hook) => hook.approved)).toEqual([false, false]);
    await s.approveHook("demo", hooks[0]!.fingerprint);
    expect((await s.hooks()).map((hook) => hook.approved)).toEqual([true, false]);
    await s.revokeHook("demo", hooks[0]!.fingerprint);
    expect((await s.hooks()).every((hook) => !hook.approved)).toBe(true);
  });

  it("a skills-only plugin lists without a global trust decision", async () => {
    const p = writePlugin(workspace, "docs", { name: "docs", version: "1.0.0", description: "d" });
    mkdirSync(join(p, "skills", "guide"), { recursive: true });
    writeFileSync(
      join(p, "skills", "guide", "SKILL.md"),
      "---\nname: guide\ndescription: d\n---\n",
    );
    expect((await svc().list())[0]!.contributions.skills).toEqual(["guide"]);
  });

  it("uninstall 404s a plugin that isn't installed globally", async () => {
    await expect(svc().uninstall("ghost")).rejects.toMatchObject({ code: "not_found" });
  });

  it("approveHook 404s an undeclared fingerprint", async () => {
    await expect(svc().approveHook("ghost", "missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("validateGitUrl rejects unsafe transports", () => {
    expect(() => validateGitUrl("http://x/y")).toThrow(/cleartext/);
    expect(() => validateGitUrl("ext::sh -c evil")).toThrow(/ext::/);
    expect(() => validateGitUrl("-flag")).toThrow(/flag/);
    expect(validateGitUrl("https://github.com/a/b.git")).toBe("https://github.com/a/b.git");
  });

  it("validateGitUrl refuses a local path in its own words", () => {
    for (const url of ["./plugins/beside", "../beside", "~/beside", "/opt/beside", "D:/beside"]) {
      expect(() => validateGitUrl(url)).toThrow(/installs a plugin from git/);
    }
  });

  it("validateGitUrl rejects a string matching none of the accepted forms", () => {
    expect(() => validateGitUrl("plainstring")).toThrow(/install from https/);
    expect(() => validateGitUrl("")).toThrow(/a git URL is required/);
  });

  it("list: a JSON-valid but schema-invalid manifest reports the zod issue path", async () => {
    writePlugin(workspace, "bad2", { name: "bad2", version: "not-semver", description: "d" });
    const [view] = await svc().list();
    expect(view!.error).toContain("version");
    expect(view!.error).toContain("semver");
  });

  it("list: a skills subdirectory without SKILL.md is not reported as a skill", async () => {
    const p = writePlugin(workspace, "docs2", {
      name: "docs2",
      version: "1.0.0",
      description: "d",
    });
    mkdirSync(join(p, "skills", "not-a-skill"), { recursive: true });
    mkdirSync(join(p, "skills", "real-skill"), { recursive: true });
    writeFileSync(
      join(p, "skills", "real-skill", "SKILL.md"),
      "---\nname: real-skill\ndescription: d\n---\n",
    );
    const [view] = await svc().list();
    expect(view!.contributions.skills).toEqual(["real-skill"]);
  });

  it("list: reports malformed skills with a bounded actionable summary", async () => {
    const dir = writePlugin(workspace, "broken-skills", { name: "broken-skills" });
    for (let index = 0; index < 5; index += 1) {
      const skill = join(dir, "skills", `broken-${String(index)}`);
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        join(skill, "SKILL.md"),
        `---\nname: broken-${String(index)}\ndescription: [unterminated\n---\n`,
      );
    }

    const [view] = await svc().list();
    expect(view!.contributions.skills).toEqual([]);
    expect(view!.notes).toHaveLength(4);
    expect(view!.notes?.at(-1)).toContain("further skill(s)");
  });

  it("list: contributes no skills from an excessive skill-directory fanout, and loads the plugin", async () => {
    const dir = writePlugin(workspace, "wide", {
      name: "wide",
      mcpServers: { dangerous: { command: "would-run" } },
    });
    for (let index = 0; index <= PLUGIN_RESOURCE_LIMITS.skillDirectoryEntries; index += 1) {
      mkdirSync(join(dir, "skills", `s-${String(index)}`), { recursive: true });
    }

    const [view] = await svc().list();
    expect(view!.error).toBeUndefined();
    expect(view!.contributions.skills).toEqual([]);
    expect(view!.contributions.servers).toEqual(["wide:dangerous"]);
  });

  it("list: refuses an excessive install-root fanout without returning a partial catalog", async () => {
    for (let index = 0; index <= PLUGIN_RESOURCE_LIMITS.installRootEntries; index += 1) {
      mkdirSync(join(workspace, "plugins", `p-${String(index)}`), { recursive: true });
    }

    await expect(svc().list()).rejects.toMatchObject({ code: "resource_exhausted" });
  });

  it("install: surfaces a git failure when the clone fails", async () => {
    await expect(
      svc().install("file:///clarvis-nonexistent-repo-xyz-does-not-exist"),
    ).rejects.toThrow(/git clone failed/);
  });

  it("coordinates install policy entirely through injected repositories and fetchers", async () => {
    const manifest = JSON.stringify({ name: "virtual", version: "1.0.0", description: "d" });
    let installed: InstalledPlugin | null = null;
    let disposed = false;
    const repository: PluginRepository = {
      async list() {
        return installed === null ? [] : [installed];
      },
      async inspect(root) {
        return virtualPlugin("staging", manifest, root);
      },
      async global(name) {
        return installed?.name === name ? installed : null;
      },
      async install(_root, name) {
        installed = virtualPlugin(name, manifest);
        return installed;
      },
      async replace(_root, name) {
        installed = virtualPlugin(name, manifest);
        return installed;
      },
      async remove(name) {
        if (installed?.name !== name) return false;
        installed = null;
        return true;
      },
    };
    const fetcher: PluginFetcher = {
      async fetch(source) {
        expect(source).toBe("https://example.test/virtual.git");
        return {
          root: "/virtual/staging",
          dispose() {
            disposed = true;
          },
        };
      },
      async update() {},
    };
    const service = createPluginService({
      globalDir: "/virtual",
      enabledPlugins: () => [],
      repository,
      fetcher,
      environment: {},
    });

    expect((await service.install("https://example.test/virtual.git")).name).toBe("virtual");
    expect(disposed).toBe(true);
    expect((await service.list()).map((plugin) => plugin.name)).toEqual(["virtual"]);
    await service.uninstall("virtual");
    expect(await service.list()).toEqual([]);
  });

  it("cancels an active plugin fetch when the kernel lifecycle closes", async () => {
    const lifecycle = createKernelLifecycle();
    const fetcher: PluginFetcher = {
      fetch(_source, _subdir, signal) {
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("plugin fetch cancelled")), {
            once: true,
          });
        });
      },
      async update() {},
    };
    const service = createPluginService({
      globalDir: "/virtual",
      enabledPlugins: () => [],
      fetcher,
      lifecycle,
      environment: {},
    });

    const install = service.install("https://example.test/virtual.git");
    await lifecycle.close();
    await expect(install).rejects.toThrow("plugin fetch cancelled");
  });

  it("refuses an update whose prepared manifest changes the installed plugin name", async () => {
    const installed = virtualPlugin(
      "virtual",
      JSON.stringify({ name: "virtual", version: "1.0.0", description: "d" }),
    );
    let disposed = false;
    const repository: PluginRepository = {
      async list() {
        return [installed];
      },
      async inspect(root) {
        return virtualPlugin(
          "staging",
          JSON.stringify({ name: "impostor", version: "1.0.0", description: "d" }),
          root,
        );
      },
      async global(name) {
        return name === installed.name ? installed : null;
      },
      async install() {
        return installed;
      },
      async replace() {
        return installed;
      },
      async remove() {
        return false;
      },
    };
    const service = createPluginService({
      globalDir: "/virtual",
      enabledPlugins: () => [],
      repository,
      fetcher: {
        async fetch() {
          throw new Error("unused");
        },
        async update() {
          return {
            root: "/virtual/staging",
            dispose() {
              disposed = true;
            },
          };
        },
      },
      environment: {},
    });

    await expect(service.update("virtual")).rejects.toMatchObject({ code: "invalid_request" });
    expect(disposed).toBe(true);
  });

  describe("install/update against a real local git remote", () => {
    it("install: refuses when a plugin of that name is already installed", async () => {
      const repo = makeGitRepo({ name: "dup", version: "1.0.0", description: "d" });
      try {
        const s = svc();
        await s.install(`file://${repo}`);
        await expect(s.install(`file://${repo}`)).rejects.toMatchObject({
          code: "invalid_request",
        });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("update: refuses a plugin that was not installed from git", async () => {
      writePlugin(
        global,
        "manual",
        { name: "manual", version: "1.0.0", description: "d" },
        "global",
      );
      await expect(svc().update("manual")).rejects.toMatchObject({ code: "invalid_request" });
    });

    it("update: fetches and hard-resets to origin HEAD", async () => {
      const repo = makeGitRepo({ name: "up", version: "1.0.0", description: "d" });
      try {
        const s = svc();
        const installed = await s.install(`file://${repo}`);
        expect(installed.version).toBe("1.0.0");

        writeFileSync(
          join(repo, "plugin.json"),
          JSON.stringify({ name: "up", version: "2.0.0", description: "d" }),
        );
        runGit(repo, "commit", "-am", "bump");

        const updated = await s.update("up");
        expect(updated.version).toBe("2.0.0");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  describe("install from a subdirectory of a multi-plugin repo", () => {
    function makeRepo(): string {
      const repo = mkdtempSync(join(tmpdir(), "clarvis-src-"));
      const git = (...args: string[]): void => runGit(repo, ...args);
      const plugin = join(repo, "plugins", "brainstorm");
      mkdirSync(plugin, { recursive: true });
      writeFileSync(
        join(plugin, "plugin.json"),
        JSON.stringify({ name: "brainstorm", version: "1.0.0", description: "Brainstorm mode." }),
      );
      mkdirSync(join(plugin, "skills", "brainstorm"), { recursive: true });
      writeFileSync(
        join(plugin, "skills", "brainstorm", "SKILL.md"),
        "---\nname: brainstorm\ndescription: d\n---\n",
      );
      git("init", "--quiet");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      git("add", "-A");
      git("commit", "--quiet", "-m", "init");
      return repo;
    }

    it("installs the plugin at the given subdir, dropping the rest of the repo", async () => {
      const repo = makeRepo();
      try {
        const view = await svc().install(`file://${repo}`, "plugins/brainstorm");
        expect(view.name).toBe("brainstorm");
        expect(view.version).toBe("1.0.0");
        expect(view.contributions.skills).toEqual(["brainstorm"]);
        expect(view.source).toBe(`file://${repo}`);
        expect(view.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(existsSync(join(view.dir, ".git"))).toBe(false);
        expect(existsSync(join(view.dir, "plugins"))).toBe(false);

        writeFileSync(
          join(repo, "plugins", "brainstorm", "plugin.json"),
          JSON.stringify({
            name: "brainstorm",
            version: "2.0.0",
            description: "Brainstorm mode.",
          }),
        );
        runGit(repo, "add", "-A");
        runGit(repo, "commit", "-m", "bump nested plugin");
        const updated = await svc().update("brainstorm");
        expect(updated.version).toBe("2.0.0");
        expect(updated.source).toBe(`file://${repo}`);
        expect(updated.revision).not.toBe(view.revision);
        expect(existsSync(join(updated.dir, "plugins"))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("refuses a subdir that escapes the checkout", async () => {
      const repo = makeRepo();
      try {
        await expect(svc().install(`file://${repo}`, "../../etc")).rejects.toMatchObject({
          code: "invalid_request",
        });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("reports a subdir with no plugin.json instead of installing", async () => {
      const repo = makeRepo();
      try {
        await expect(svc().install(`file://${repo}`, "plugins")).rejects.toMatchObject({
          code: "invalid_request",
        });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
