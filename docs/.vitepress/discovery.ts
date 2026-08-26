import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export type PublicDocsLocale = "en" | "pt-BR";

export type PublicDocsDescriptions = Record<PublicDocsLocale, string>;

export type PublicDocPage = {
  contentRoute: string;
  description: string;
  language: "en-US" | "pt-BR";
  locale: PublicDocsLocale;
  markdownPath: string;
  relativePath: string;
  route: string;
  source: string;
  title: string;
};

export type DiscoveryOptions = {
  descriptions: PublicDocsDescriptions;
  docsRoot: string;
  outDir: string;
  repo: string;
  site: string;
};

export type LanguageAlternate = {
  href: string;
  hreflang: PublicDocsLocale | "x-default";
};

const ignoredDirectories = new Set([".vitepress", "_partials", "public"]);
const ignoredFiles = new Set(["README.md", "oss-launch-checklist.md"]);
const localeOrder = ["en", "pt-BR"] as const;
const localeMetadata = {
  en: { language: "en-US", prefix: "" },
  "pt-BR": { language: "pt-BR", prefix: "/pt-BR" },
} as const;

const discoveryCopy = {
  en: {
    canonicalHtml: "Canonical HTML",
    completeExportDescription: "A single consolidated Markdown export for offline retrieval.",
    completeExportLabel: "All Clarvis documentation",
    completeExportTitle: "Complete export",
    documentationIndex: "Documentation index",
    fullExportIntro:
      "This consolidated export mirrors the public documentation. Prefer llms.txt and page-specific Markdown when selective retrieval is available.",
    fullExportTitle: "Clarvis documentation",
    homeIntro:
      "Clarvis gives an operator one terminal workspace for directing coding agents, reviewing their work, and extending their behavior.",
    indexIntro:
      "The links below are clean Markdown alternatives to the public documentation. Follow only the pages needed for the current task.",
    projectTitle: "Project",
    repositoryDescription: "Clarvis source code, releases, issues, and license.",
    repositoryLabel: "Source repository",
    startHere: "Start here",
  },
  "pt-BR": {
    canonicalHtml: "HTML canônico",
    completeExportDescription:
      "Uma única exportação consolidada em Markdown para consulta offline.",
    completeExportLabel: "Toda a documentação do Clarvis",
    completeExportTitle: "Exportação completa",
    documentationIndex: "Índice da documentação",
    fullExportIntro:
      "Esta exportação consolidada espelha a documentação pública. Prefira llms.txt e o Markdown específico de cada página quando a consulta seletiva estiver disponível.",
    fullExportTitle: "Documentação do Clarvis",
    homeIntro:
      "O Clarvis oferece ao operador um único workspace no terminal para orientar agentes de código, revisar o trabalho e ampliar seu comportamento.",
    indexIntro:
      "Os links abaixo são alternativas limpas em Markdown para a documentação pública. Consulte apenas as páginas necessárias para a tarefa atual.",
    projectTitle: "Projeto",
    repositoryDescription: "Código-fonte, releases, issues e licença do Clarvis.",
    repositoryLabel: "Repositório do código-fonte",
    startHere: "Comece aqui",
  },
} as const;

const llmsSections = [
  {
    title: { en: "Start here", "pt-BR": "Comece aqui" },
    routes: [
      "/installation",
      "/getting-started",
      "/guide/daily-use",
      "/guide/providers-and-models",
      "/guide/safety",
    ],
  },
  {
    title: { en: "Plan and operate", "pt-BR": "Planeje e opere" },
    routes: ["/guide/plans", "/guide/worktrees", "/guide/agents", "/guide/workflows"],
  },
  {
    title: { en: "Extend Clarvis", "pt-BR": "Estenda o Clarvis" },
    routes: [
      "/guide/skills",
      "/guide/hooks",
      "/guide/mcp-servers",
      "/guide/plugins",
      "/guide/marketplaces",
    ],
  },
  {
    title: { en: "Reference", "pt-BR": "Referência" },
    routes: ["/reference/configuration", "/reference/commands", "/reference/extensions"],
  },
  {
    title: { en: "Concepts", "pt-BR": "Conceitos" },
    routes: ["/explanation/how-clarvis-works", "/explanation/scopes-and-trust"],
  },
  {
    title: { en: "Operations and security", "pt-BR": "Operações e segurança" },
    routes: ["/operations/troubleshooting", "/terminal-compatibility", "/operations/security"],
  },
] as const;

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (entry.isDirectory()) {
        return ignoredDirectories.has(entry.name) ? [] : markdownFiles(join(directory, entry.name));
      }
      return entry.isFile() && entry.name.endsWith(".md") && !ignoredFiles.has(entry.name)
        ? [join(directory, entry.name)]
        : [];
    });
}

function stripFrontmatter(source: string): string {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const closing = normalized.indexOf("\n---\n", 4);
  return closing === -1 ? normalized : normalized.slice(closing + 5);
}

function titleFrom(source: string): string | undefined {
  return /^#\s+(.+?)\s*$/m.exec(source)?.[1];
}

function descriptionFrom(source: string): string | undefined {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith(">"));
  if (start === -1) return undefined;

  const description: string[] = [];
  for (let index = start; index < lines.length && lines[index]?.startsWith(">"); index += 1) {
    description.push(lines[index]!.replace(/^>\s?/, "").trim());
  }
  return description.join(" ").replace(/\s+/g, " ").trim() || undefined;
}

function localeFrom(relativePath: string): PublicDocsLocale {
  return relativePath.startsWith("pt-BR/") ? "pt-BR" : "en";
}

function contentPathFrom(relativePath: string, locale: PublicDocsLocale): string {
  return locale === "pt-BR" ? relativePath.slice("pt-BR/".length) : relativePath;
}

function contentRouteFrom(contentPath: string): string {
  const withoutExtension = contentPath.slice(0, -3);
  return withoutExtension === "index" ? "/" : `/${withoutExtension}`;
}

function localizedRoute(contentRoute: string, locale: PublicDocsLocale): string {
  const prefix = localeMetadata[locale].prefix;
  if (!prefix) return contentRoute;
  return contentRoute === "/" ? `${prefix}/` : `${prefix}${contentRoute}`;
}

function absoluteUrl(site: string, path: string): string {
  return new URL(path, `${site.replace(/\/$/, "")}/`).toString();
}

function cleanMarkdown(source: string): string {
  return stripFrontmatter(source)
    .replace(/<script\s+setup[^>]*>[\s\S]*?<\/script>\s*/g, "")
    .replace(/^<Home[A-Z][A-Za-z]+(?:\s+[^>]*)?\s*\/>\s*$/gm, "")
    .trim();
}

function pagesForLocale(pages: PublicDocPage[], locale: PublicDocsLocale): PublicDocPage[] {
  return pages.filter((page) => page.locale === locale);
}

function agentIndexPath(locale: PublicDocsLocale): string {
  return locale === "en" ? "/llms.txt" : "/pt-BR/llms.txt";
}

function fullExportPath(locale: PublicDocsLocale): string {
  return locale === "en" ? "/llms-full.txt" : "/pt-BR/llms-full.txt";
}

/** Reads every published Markdown page and derives its locale, HTML route, and Markdown route. */
export function discoverPublicDocs(
  docsRoot: string,
  descriptions: PublicDocsDescriptions,
): PublicDocPage[] {
  return markdownFiles(docsRoot).map((path) => {
    const relativePath = relative(docsRoot, path).split(sep).join("/");
    const locale = localeFrom(relativePath);
    const contentPath = contentPathFrom(relativePath, locale);
    const contentRoute = contentRouteFrom(contentPath);
    const source = readFileSync(path, "utf8");
    const home = contentRoute === "/";
    const title = home ? "Clarvis" : titleFrom(source);
    const description = home ? descriptions[locale] : descriptionFrom(source);

    if (!title || !description) {
      throw new Error(`public documentation needs a title and summary: ${relativePath}`);
    }

    return {
      contentRoute,
      description,
      language: localeMetadata[locale].language,
      locale,
      markdownPath: `/${relativePath}`,
      relativePath,
      route: localizedRoute(contentRoute, locale),
      source,
      title,
    };
  });
}

/** Returns the canonical clean URL for one public page. */
export function canonicalUrlFor(page: PublicDocPage, site: string): string {
  return absoluteUrl(site, page.route);
}

/** Returns the agent-readable Markdown alternative for one public page. */
export function markdownUrlFor(page: PublicDocPage, site: string): string {
  return absoluteUrl(site, page.markdownPath);
}

/** Returns the locale-specific agent index for one public page. */
export function agentIndexUrlFor(page: PublicDocPage, site: string): string {
  return absoluteUrl(site, agentIndexPath(page.locale));
}

/** Returns every language alternative for a page, including the English x-default. */
export function translationAlternatesFor(
  page: PublicDocPage,
  pages: PublicDocPage[],
  site: string,
): LanguageAlternate[] {
  const translations = localeOrder.map((locale) => {
    const translation = pages.find(
      (candidate) => candidate.locale === locale && candidate.contentRoute === page.contentRoute,
    );
    if (!translation) {
      throw new Error(
        `public documentation is missing ${locale} translation: ${page.contentRoute}`,
      );
    }
    return { href: canonicalUrlFor(translation, site), hreflang: locale };
  });
  return [...translations, { href: translations[0].href, hreflang: "x-default" as const }];
}

/** Renders the root crawler policy without assigning special privileges to named bots. */
export function renderRobotsTxt(site: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl(site, "/sitemap.xml")}\n`;
}

/** Renders one locale's concise llms.txt index and rejects uncategorized documentation. */
export function renderLlmsTxt(
  pages: PublicDocPage[],
  options: Pick<DiscoveryOptions, "descriptions" | "repo" | "site">,
  locale: PublicDocsLocale,
): string {
  const localizedPages = pagesForLocale(pages, locale);
  const byRoute = new Map(localizedPages.map((page) => [page.contentRoute, page]));
  const categorized = new Set<string>();
  const sections = llmsSections.map((section) => {
    const links = section.routes.map((route) => {
      const page = byRoute.get(route);
      if (!page) throw new Error(`llms.txt references a missing ${locale} page: ${route}`);
      if (categorized.has(route)) throw new Error(`llms.txt categorizes a page twice: ${route}`);
      categorized.add(route);
      return `- [${page.title}](${markdownUrlFor(page, options.site)}): ${page.description}`;
    });
    return `## ${section.title[locale]}\n\n${links.join("\n")}`;
  });

  const uncategorized = localizedPages
    .filter((page) => page.contentRoute !== "/" && !categorized.has(page.contentRoute))
    .map((page) => page.route);
  if (uncategorized.length > 0) {
    throw new Error(`llms.txt needs a category for: ${uncategorized.join(", ")}`);
  }

  const copy = discoveryCopy[locale];
  return [
    "# Clarvis",
    `> ${options.descriptions[locale]}`,
    copy.indexIntro,
    ...sections,
    `## ${copy.completeExportTitle}`,
    `- [${copy.completeExportLabel}](${absoluteUrl(options.site, fullExportPath(locale))}): ${copy.completeExportDescription}`,
    `## ${copy.projectTitle}`,
    `- [${copy.repositoryLabel}](${options.repo}): ${copy.repositoryDescription}`,
    "",
  ].join("\n\n");
}

/** Renders a clean Markdown alternative for a human-facing documentation page. */
export function renderMarkdownPage(
  page: PublicDocPage,
  pages: PublicDocPage[],
  options: Pick<DiscoveryOptions, "descriptions" | "site">,
): string {
  const copy = discoveryCopy[page.locale];
  let content = cleanMarkdown(page.source);
  if (page.contentRoute === "/") {
    const localizedPages = pagesForLocale(pages, page.locale);
    const startingRoutes = llmsSections[0].routes;
    const links = startingRoutes.map((route) => {
      const target = localizedPages.find((candidate) => candidate.contentRoute === route);
      if (!target) throw new Error(`agent home references a missing ${page.locale} page: ${route}`);
      return `- [${target.title}](${markdownUrlFor(target, options.site)}): ${target.description}`;
    });
    content = [
      "# Clarvis",
      `> ${options.descriptions[page.locale]}`,
      copy.homeIntro,
      `## ${copy.startHere}`,
      links.join("\n"),
    ].join("\n\n");
  }

  return [
    content,
    "---",
    `[${copy.canonicalHtml}](${canonicalUrlFor(page, options.site)})`,
    `[${copy.documentationIndex}](${agentIndexUrlFor(page, options.site)})`,
    "",
  ].join("\n\n");
}

/** Renders one locale's compatibility export containing every machine-readable page. */
export function renderLlmsFullTxt(
  pages: PublicDocPage[],
  options: Pick<DiscoveryOptions, "descriptions" | "site">,
  locale: PublicDocsLocale,
): string {
  const copy = discoveryCopy[locale];
  return [
    `# ${copy.fullExportTitle}`,
    `> ${options.descriptions[locale]}`,
    copy.fullExportIntro,
    ...pagesForLocale(pages, locale).map((page) => renderMarkdownPage(page, pages, options).trim()),
    "",
  ].join("\n\n");
}

function requiredFile(path: string): string {
  if (!existsSync(path)) throw new Error(`public documentation artifact is missing: ${path}`);
  return readFileSync(path, "utf8");
}

function htmlPathFor(page: PublicDocPage, outDir: string): string {
  return page.route === "/"
    ? join(outDir, "index.html")
    : join(outDir, `${page.route.slice(1).replace(/\/$/, "/index")}.html`);
}

/** Verifies the complete rendered crawler contract before the Pages artifact can be uploaded. */
function assertDiscoveryArtifacts(options: DiscoveryOptions, pages: PublicDocPage[]): void {
  const indexes = new Map(
    localeOrder.map((locale) => [
      locale,
      requiredFile(join(options.outDir, agentIndexPath(locale).slice(1))),
    ]),
  );
  const robots = requiredFile(join(options.outDir, "robots.txt"));
  for (const locale of localeOrder) {
    requiredFile(join(options.outDir, fullExportPath(locale).slice(1)));
  }
  if (!existsSync(join(options.outDir, "og.png"))) {
    throw new Error("public documentation artifact is missing: og.png");
  }
  if (robots !== renderRobotsTxt(options.site)) {
    throw new Error("public documentation robots.txt does not match the canonical crawler policy");
  }

  for (const page of pages) {
    const canonical = canonicalUrlFor(page, options.site);
    const markdown = markdownUrlFor(page, options.site);
    const index = agentIndexUrlFor(page, options.site);
    const html = requiredFile(htmlPathFor(page, options.outDir));
    requiredFile(join(options.outDir, page.relativePath));

    const expected = [
      `<link rel="canonical" href="${canonical}">`,
      `<link rel="alternate" type="text/markdown" href="${markdown}">`,
      `<link rel="describedby" href="${index}">`,
      `<meta property="og:locale" content="${page.locale === "en" ? "en_US" : "pt_BR"}">`,
      '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">',
      '<script type="application/ld+json">',
      `"inLanguage":"${page.language}"`,
      ...translationAlternatesFor(page, pages, options.site).map(
        ({ href, hreflang }) => `<link rel="alternate" hreflang="${hreflang}" href="${href}">`,
      ),
    ];
    for (const token of expected) {
      if (html.split(token).length !== 2) {
        throw new Error(`public documentation needs exactly one ${token}: ${page.relativePath}`);
      }
    }
    if (page.contentRoute !== "/" && !indexes.get(page.locale)?.includes(markdown)) {
      throw new Error(`public documentation agent index is missing: ${markdown}`);
    }
  }

  const notFound = requiredFile(join(options.outDir, "404.html"));
  if (!notFound.includes('<meta name="robots" content="noindex, nofollow">')) {
    throw new Error("public documentation 404 page must be noindex");
  }
}

/** Writes crawler and locale-specific agent discovery artifacts into the VitePress output. */
export function generateDiscoveryArtifacts(options: DiscoveryOptions): void {
  const pages = discoverPublicDocs(options.docsRoot, options.descriptions);
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(join(options.outDir, "robots.txt"), renderRobotsTxt(options.site));
  for (const locale of localeOrder) {
    const indexPath = join(options.outDir, agentIndexPath(locale).slice(1));
    const exportPath = join(options.outDir, fullExportPath(locale).slice(1));
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, renderLlmsTxt(pages, options, locale));
    writeFileSync(exportPath, renderLlmsFullTxt(pages, options, locale));
  }

  for (const page of pages) {
    const output = join(options.outDir, page.relativePath);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, renderMarkdownPage(page, pages, options));
  }

  assertDiscoveryArtifacts(options, pages);
}
