import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentFrontmatterSchema,
  kernelSettingsSchema,
  marketplaceSchema,
  parsePluginManifest,
} from "@clarvis/kernel/config";
import { splitAgentFrontmatter } from "@clarvis/loop/host";
import { workflowFrontmatterSchema } from "@clarvis/workflows/artifact";
import {
  agentIndexUrlFor,
  canonicalUrlFor,
  discoverPublicDocs,
  markdownUrlFor,
  renderLlmsFullTxt,
  renderLlmsTxt,
  renderMarkdownPage,
  renderRobotsTxt,
  translationAlternatesFor,
  type PublicDocsLocale,
} from "../../../docs/.vitepress/discovery.ts";

const root = resolve(import.meta.dir, "../../..");
const docsRoot = resolve(root, "docs");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const descriptions = {
  en: "A terminal workspace for running, supervising, and extending coding agents with explicit safety, context, and human review.",
  "pt-BR":
    "Um workspace no terminal para executar, supervisionar e estender agentes de código com segurança explícita, contexto e revisão humana.",
} as const;
const locales = ["en", "pt-BR"] as const satisfies readonly PublicDocsLocale[];

function localizedPath(locale: PublicDocsLocale, path: string): string {
  return locale === "en" ? `docs/${path}` : `docs/pt-BR/${path}`;
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function pngSize(path: string): { width: number; height: number } {
  const source = readFileSync(path);
  expect(source.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: source.readUInt32BE(16), height: source.readUInt32BE(20) };
}

function fencedBlocks(source: string, language: string): string[] {
  const fence = new RegExp("^```" + language + "\\s*\\n([\\s\\S]*?)^```\\s*$", "gm");
  return [...source.matchAll(fence)].map((match) => match[1].trim());
}

describe("public documentation", () => {
  test("uses the canonical product identity and root-owned version", () => {
    const config = read("docs/.vitepress/config.ts");
    expect(config).toContain('const repo = "https://github.com/getclarvis/clarvis"');
    expect(config).toContain('const site = "https://clarvis.dev"');
    expect(config).toContain("const productVersion = productManifest.version");

    const manifest = JSON.parse(read("package.json")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.scripts?.["docs:dev"]).toBe("vitepress dev docs");
    expect(manifest.scripts?.["docs:build"]).toBe("vitepress build docs");
    expect(manifest.scripts?.["docs:preview"]).toBe("vitepress preview docs");
    expect(manifest.devDependencies?.vitepress).toBe("^1.6.4");
  });

  test("keeps the primary install commands short, versioned, and aligned", () => {
    const manifest = JSON.parse(read("package.json")) as { version: string };
    const unixCommand = `curl -fsSL https://raw.githubusercontent.com/getclarvis/clarvis/v${manifest.version}/install.sh | sh`;
    const windowsCommand = `irm https://raw.githubusercontent.com/getclarvis/clarvis/v${manifest.version}/install.ps1 | iex`;

    for (const path of ["README.md", "docs/installation.md", "docs/pt-BR/installation.md"]) {
      const source = read(path);
      expect(fencedBlocks(source, "bash")[0], path).toBe(unixCommand);
      expect(fencedBlocks(source, "powershell")[0], path).toBe(windowsCommand);
    }

    const homeInstall = read("docs/.vitepress/theme/components/HomeInstall.vue");
    expect(homeInstall).toContain(
      "value: `curl -fsSL https://raw.githubusercontent.com/getclarvis/clarvis/v${productVersion.value}/install.sh | sh`",
    );
    expect(homeInstall).toContain(
      "value: `irm https://raw.githubusercontent.com/getclarvis/clarvis/v${productVersion.value}/install.ps1 | iex`",
    );
    expect(homeInstall).not.toContain("mktemp");
    expect(homeInstall).toContain('guideLink: "/installation"');
    expect(homeInstall).toContain('guideLink: "/pt-BR/installation"');

    for (const path of ["docs/installation.md", "docs/pt-BR/installation.md"]) {
      const source = read(path);
      const reviewCommand = fencedBlocks(source, "bash").find((block) =>
        block.includes('less "$installer"'),
      );
      expect(reviewCommand?.startsWith("(\nset -e\n"), path).toBe(true);
      const powerShellReview = fencedBlocks(source, "powershell").find((block) =>
        block.includes("Get-Content $installer"),
      );
      expect(powerShellReview, path).toContain("-ErrorAction Stop");
    }
  });

  test("keeps user guides free of repository-internal citations and the temporary remote", () => {
    const files = markdownFiles(docsRoot);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("evandrocabf/getclarvis");
      expect(source, file).not.toContain("—");
      expect(source, file).not.toMatch(/(?:^|[(/`])specs\//m);
      expect(source, file).not.toMatch(/packages\/[a-z0-9-]+\/src\//);
    }
  });

  test("ships the complete task-oriented guide set", () => {
    for (const locale of locales) {
      for (const relativePath of [
        "getting-started.md",
        "installation.md",
        "guide/providers-and-models.md",
        "guide/plans.md",
        "guide/worktrees.md",
        "guide/agents.md",
        "guide/workflows.md",
        "guide/safety.md",
        "guide/hooks.md",
        "guide/mcp-servers.md",
        "guide/skills.md",
        "guide/plugins.md",
        "guide/marketplaces.md",
        "terminal-compatibility.md",
      ]) {
        const path = localizedPath(locale, relativePath);
        expect(read(path).length, path).toBeGreaterThan(200);
      }
    }

    const config = read("docs/.vitepress/config.ts");
    expect(config).toContain('{ text: "Install and update", link: "/installation" }');
    expect(config).toContain('{ text: "Terminal compatibility", link: "/terminal-compatibility" }');
    expect(config).toContain('text: "Instalação e atualização"');
    expect(config).toContain('link: "/pt-BR/installation"');
    expect(config).toContain('text: "Compatibilidade do terminal"');
    expect(config).toContain('link: "/pt-BR/terminal-compatibility"');
  });

  test("keeps the English and Brazilian Portuguese page trees complete and isolated", () => {
    const pages = discoverPublicDocs(docsRoot, descriptions);
    const byContentRoute = new Map<string, Set<PublicDocsLocale>>();
    for (const page of pages) {
      const present = byContentRoute.get(page.contentRoute) ?? new Set<PublicDocsLocale>();
      present.add(page.locale);
      byContentRoute.set(page.contentRoute, present);
    }

    for (const [contentRoute, present] of byContentRoute) {
      expect(present, contentRoute).toEqual(new Set(locales));
    }
    expect(pages.filter(({ locale }) => locale === "en").length).toBe(
      pages.filter(({ locale }) => locale === "pt-BR").length,
    );

    for (const page of pages.filter(({ locale }) => locale === "pt-BR")) {
      expect(page.route, page.relativePath).toMatch(/^\/pt-BR\//);
      expect(page.markdownPath, page.relativePath).toMatch(/^\/pt-BR\//);
      expect(page.source, page.relativePath).not.toMatch(
        /(?<!\/pt-BR)\/(?:getting-started|guide|reference|explanation|operations)(?:\/|[\s)"'#])/,
      );
    }
    expect(pages.some(({ relativePath }) => relativePath === "oss-launch-checklist.md")).toBe(
      false,
    );
  });

  test("keeps published configuration examples valid against the product schemas", () => {
    for (const file of markdownFiles(docsRoot)) {
      const source = readFileSync(file, "utf8");
      for (const [index, block] of fencedBlocks(source, "json").entries()) {
        expect(() => JSON.parse(block), `${file} JSON block ${index + 1}`).not.toThrow();
      }
    }

    for (const locale of locales) {
      for (const relativePath of ["reference/configuration.md", "guide/safety.md"]) {
        const path = localizedPath(locale, relativePath);
        for (const [index, block] of fencedBlocks(read(path), "json").entries()) {
          const parsed = kernelSettingsSchema.safeParse(JSON.parse(block));
          const detail = parsed.success ? "" : parsed.error.message;
          expect(parsed.success, `${path} settings block ${index + 1}: ${detail}`).toBe(true);
        }
      }
    }

    for (const locale of locales) {
      for (const relativePath of ["guide/agents.md", "reference/configuration.md"]) {
        const path = localizedPath(locale, relativePath);
        for (const [index, block] of fencedBlocks(read(path), "md")
          .filter((value) => value.startsWith("---\n"))
          .entries()) {
          const parsed = agentFrontmatterSchema.safeParse(splitAgentFrontmatter(block).data);
          const detail = parsed.success ? "" : parsed.error.message;
          expect(parsed.success, `${path} agent block ${index + 1}: ${detail}`).toBe(true);
        }
      }
    }

    for (const locale of locales) {
      const workflowPath = localizedPath(locale, "guide/workflows.md");
      const workflow = fencedBlocks(read(workflowPath), "md").find((block) =>
        block.startsWith("---\n"),
      );
      expect(workflow).toBeDefined();
      const workflowParsed = workflowFrontmatterSchema.safeParse(
        splitAgentFrontmatter(workflow).data,
      );
      const workflowDetail = workflowParsed.success ? "" : workflowParsed.error.message;
      expect(workflowParsed.success, `${workflowPath}: ${workflowDetail}`).toBe(true);

      const pluginPath = localizedPath(locale, "guide/plugins.md");
      const plugin = fencedBlocks(read(pluginPath), "json")[0];
      expect(plugin).toBeDefined();
      const pluginParsed = parsePluginManifest(plugin);
      let pluginDetail = "";
      if ("error" in pluginParsed) {
        pluginDetail = pluginParsed.error instanceof Error ? pluginParsed.error.message : "unknown";
      }
      expect(pluginParsed.ok, `${pluginPath}: ${pluginDetail}`).toBe(true);

      const marketplacePath = localizedPath(locale, "guide/marketplaces.md");
      const marketplace = fencedBlocks(read(marketplacePath), "json")[0];
      expect(marketplace).toBeDefined();
      const marketplaceParsed = marketplaceSchema.safeParse(JSON.parse(marketplace));
      const marketplaceDetail = marketplaceParsed.success ? "" : marketplaceParsed.error.message;
      expect(marketplaceParsed.success, `${marketplacePath}: ${marketplaceDetail}`).toBe(true);
    }
  });

  test("keeps every published TUI capture at one viewport-derived size", () => {
    const imageRoot = resolve(docsRoot, "public/images/tui");
    const images = readdirSync(imageRoot)
      .filter((name) => name.endsWith(".png"))
      .sort();
    expect(images.length).toBeGreaterThanOrEqual(10);
    const sizes = images.map((name) => pngSize(resolve(imageRoot, name)));
    expect(new Set(sizes.map(({ width, height }) => `${width}x${height}`))).toEqual(
      new Set(["2352x1430"]),
    );

    for (const locale of locales) {
      const guideSource = [
        read(localizedPath(locale, "guide/providers-and-models.md")),
        read(localizedPath(locale, "guide/plans.md")),
        read(localizedPath(locale, "guide/worktrees.md")),
      ].join("\n");
      for (const image of images) expect(guideSource).toContain(`/images/tui/${image}`);
    }
  });

  test("pins every third-party action in the Pages workflow", () => {
    const workflow = read(".github/workflows/docs.yml");
    expect(workflow).not.toMatch(/^\s*uses:\s+[^\s@]+@v\d+/m);
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("docs/.vitepress/dist");
  });

  test("publishes canonical crawler and agent discovery surfaces", () => {
    const site = "https://clarvis.dev";
    const repo = "https://github.com/getclarvis/clarvis";
    const pages = discoverPublicDocs(docsRoot, descriptions);
    expect(pages.length).toBeGreaterThan(40);
    expect(new Set(pages.map(({ route }) => route)).size).toBe(pages.length);

    for (const locale of locales) {
      const llms = renderLlmsTxt(pages, { descriptions, repo, site }, locale);
      for (const page of pages.filter(
        (candidate) => candidate.locale === locale && candidate.contentRoute !== "/",
      )) {
        expect(llms, page.relativePath).toContain(markdownUrlFor(page, site));
        const markdown = renderMarkdownPage(page, pages, { descriptions, site });
        expect(markdown, page.relativePath).toContain(canonicalUrlFor(page, site));
        expect(markdown, page.relativePath).toContain(agentIndexUrlFor(page, site));
        expect(translationAlternatesFor(page, pages, site)).toEqual([
          { href: `https://clarvis.dev${page.contentRoute}`, hreflang: "en" },
          {
            href: `https://clarvis.dev/pt-BR${page.contentRoute}`,
            hreflang: "pt-BR",
          },
          { href: `https://clarvis.dev${page.contentRoute}`, hreflang: "x-default" },
        ]);
      }
      for (const page of pages.filter((candidate) => candidate.locale !== locale)) {
        expect(llms, page.relativePath).not.toContain(markdownUrlFor(page, site));
      }
    }
    const englishFullExport = renderLlmsFullTxt(pages, { descriptions, site }, "en");
    const portugueseFullExport = renderLlmsFullTxt(pages, { descriptions, site }, "pt-BR");
    expect(englishFullExport).toContain("# Clarvis documentation");
    expect(englishFullExport).not.toContain("https://clarvis.dev/pt-BR/");
    expect(portugueseFullExport).toContain("# Documentação do Clarvis");
    expect(portugueseFullExport).toContain("https://clarvis.dev/pt-BR/");
    const englishHome = pages.find((page) => page.locale === "en" && page.contentRoute === "/");
    expect(englishHome).toBeDefined();
    expect(() =>
      renderLlmsTxt(
        [
          ...pages,
          {
            ...englishHome,
            contentRoute: "/uncategorized",
            markdownPath: "/uncategorized.md",
            relativePath: "uncategorized.md",
            route: "/uncategorized",
            title: "Uncategorized",
          },
        ],
        { descriptions, repo, site },
        "en",
      ),
    ).toThrow("llms.txt needs a category for: /uncategorized");
    expect(renderRobotsTxt(site)).toBe(
      "User-agent: *\nAllow: /\n\nSitemap: https://clarvis.dev/sitemap.xml\n",
    );

    const config = read("docs/.vitepress/config.ts");
    expect(config).toContain("transformPageData(pageData)");
    expect(config).toContain("buildEnd(siteConfig)");
    expect(config).toContain('rel: "canonical"');
    expect(config).toContain('rel: "alternate", type: "text/markdown"');
    expect(config).toContain('rel: "alternate", hreflang');
    expect(config).toContain('rel: "describedby"');
    expect(config).toContain('type: "application/ld+json"');
    expect(config).toContain('label: "Português (Brasil)"');
    expect(config).toContain('link: "/pt-BR/"');

    expect(pngSize(resolve(docsRoot, "public/og.png"))).toEqual({ width: 1200, height: 630 });
  });
});
