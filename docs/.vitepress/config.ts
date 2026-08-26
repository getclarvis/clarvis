import { fileURLToPath } from "node:url";
import { defineConfigWithTheme, type DefaultTheme, type HeadConfig } from "vitepress";
import productManifest from "../../package.json" with { type: "json" };
import {
  agentIndexUrlFor,
  canonicalUrlFor,
  discoverPublicDocs,
  generateDiscoveryArtifacts,
  markdownUrlFor,
  translationAlternatesFor,
  type PublicDocPage,
  type PublicDocsDescriptions,
} from "./discovery.ts";

const repo = "https://github.com/getclarvis/clarvis";
const site = "https://clarvis.dev";
const productVersion = productManifest.version;

type ClarvisThemeConfig = DefaultTheme.Config & {
  productVersion: string;
};

const descriptions = {
  en: "A terminal workspace for running, supervising, and extending coding agents with explicit safety, context, and human review.",
  "pt-BR":
    "Um workspace no terminal para executar, supervisionar e estender agentes de código com segurança explícita, contexto e revisão humana.",
} satisfies PublicDocsDescriptions;
const docsRoot = fileURLToPath(new URL("../", import.meta.url));
const publicDocs = discoverPublicDocs(docsRoot, descriptions);
const publicDocsByPath = new Map(publicDocs.map((page) => [page.relativePath, page]));
const socialImage = `${site}/og.png`;

function discoveryHead(page: PublicDocPage, lastUpdated?: number): HeadConfig[] {
  const canonical = canonicalUrlFor(page, site);
  const markdown = markdownUrlFor(page, site);
  const pageTitle = page.contentRoute === "/" ? "Clarvis" : `${page.title} | Clarvis`;
  const modified = lastUpdated ? new Date(lastUpdated).toISOString() : undefined;
  const ogLocale = page.locale === "en" ? "en_US" : "pt_BR";
  const alternateOgLocale = page.locale === "en" ? "pt_BR" : "en_US";
  const pageSchema = {
    "@type": page.contentRoute === "/" ? "WebPage" : "TechArticle",
    "@id": `${canonical}#webpage`,
    url: canonical,
    name: pageTitle,
    headline: page.title,
    description: page.description,
    inLanguage: page.language,
    isPartOf: { "@id": `${site}/#website` },
    about: { "@id": `${site}/#organization` },
    publisher: { "@id": `${site}/#organization` },
    primaryImageOfPage: socialImage,
    ...(modified ? { dateModified: modified } : {}),
  };
  const structuredData = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${site}/#organization`,
        name: "Clarvis",
        url: `${site}/`,
        logo: `${site}/logo.svg`,
        sameAs: [repo],
      },
      {
        "@type": "WebSite",
        "@id": `${site}/#website`,
        url: `${site}/`,
        name: "Clarvis",
        description: descriptions[page.locale],
        inLanguage: ["en-US", "pt-BR"],
        publisher: { "@id": `${site}/#organization` },
      },
      pageSchema,
    ],
  }).replaceAll("<", "\\u003c");

  return [
    ["link", { rel: "canonical", href: canonical }],
    ["link", { rel: "alternate", type: "text/markdown", href: markdown }],
    ...translationAlternatesFor(page, publicDocs, site).map(
      ({ href, hreflang }) => ["link", { rel: "alternate", hreflang, href }] as HeadConfig,
    ),
    ["link", { rel: "describedby", href: agentIndexUrlFor(page, site) }],
    [
      "meta",
      {
        name: "robots",
        content: "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
      },
    ],
    ["meta", { property: "og:type", content: page.contentRoute === "/" ? "website" : "article" }],
    ["meta", { property: "og:locale", content: ogLocale }],
    ["meta", { property: "og:locale:alternate", content: alternateOgLocale }],
    ["meta", { property: "og:title", content: pageTitle }],
    ["meta", { property: "og:description", content: page.description }],
    ["meta", { property: "og:url", content: canonical }],
    ["meta", { property: "og:image", content: socialImage }],
    ["meta", { property: "og:image:type", content: "image/png" }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:image:alt", content: "Clarvis" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: pageTitle }],
    ["meta", { name: "twitter:description", content: page.description }],
    ["meta", { name: "twitter:image", content: socialImage }],
    ["meta", { name: "twitter:image:alt", content: "Clarvis" }],
    ...(modified && page.contentRoute !== "/"
      ? [["meta", { property: "article:modified_time", content: modified }] as HeadConfig]
      : []),
    ["script", { type: "application/ld+json" }, structuredData],
  ];
}

const gettingStartedGroup = {
  text: "Getting started",
  collapsed: false,
  items: [
    { text: "Your first Clarvis session", link: "/getting-started" },
    { text: "Install and update", link: "/installation" },
  ],
};

const guideGroup = {
  text: "Guide",
  collapsed: false,
  items: [
    { text: "Daily use", link: "/guide/daily-use" },
    { text: "Providers and models", link: "/guide/providers-and-models" },
    { text: "Plans", link: "/guide/plans" },
    { text: "Worktrees", link: "/guide/worktrees" },
    { text: "Agents", link: "/guide/agents" },
    { text: "Workflows", link: "/guide/workflows" },
    { text: "Safety and control", link: "/guide/safety" },
  ],
};

const extensionsGroup = {
  text: "Extensions",
  collapsed: false,
  items: [
    { text: "Skills", link: "/guide/skills" },
    { text: "Hooks", link: "/guide/hooks" },
    { text: "MCP servers", link: "/guide/mcp-servers" },
    { text: "Plugins", link: "/guide/plugins" },
    { text: "Marketplaces", link: "/guide/marketplaces" },
  ],
};

const referenceGroup = {
  text: "Reference",
  collapsed: false,
  items: [
    { text: "Configuration", link: "/reference/configuration" },
    { text: "Commands", link: "/reference/commands" },
    { text: "Extensions", link: "/reference/extensions" },
  ],
};

const conceptsGroup = {
  text: "Concepts",
  collapsed: false,
  items: [
    { text: "How Clarvis works", link: "/explanation/how-clarvis-works" },
    { text: "Scopes and workspace trust", link: "/explanation/scopes-and-trust" },
  ],
};

const operationsGroup = {
  text: "Operations & security",
  collapsed: false,
  items: [
    { text: "Troubleshooting", link: "/operations/troubleshooting" },
    { text: "Terminal compatibility", link: "/terminal-compatibility" },
    { text: "Security", link: "/operations/security" },
  ],
};

const portugueseGettingStartedGroup = {
  text: "Primeiros passos",
  collapsed: false,
  items: [
    { text: "Sua primeira sessão no Clarvis", link: "/pt-BR/getting-started" },
    { text: "Instalação e atualização", link: "/pt-BR/installation" },
  ],
};

const portugueseGuideGroup = {
  text: "Guia",
  collapsed: false,
  items: [
    { text: "Uso diário", link: "/pt-BR/guide/daily-use" },
    { text: "Provedores e modelos", link: "/pt-BR/guide/providers-and-models" },
    { text: "Planos", link: "/pt-BR/guide/plans" },
    { text: "Worktrees", link: "/pt-BR/guide/worktrees" },
    { text: "Agentes", link: "/pt-BR/guide/agents" },
    { text: "Workflows", link: "/pt-BR/guide/workflows" },
    { text: "Segurança e controle", link: "/pt-BR/guide/safety" },
  ],
};

const portugueseExtensionsGroup = {
  text: "Extensões",
  collapsed: false,
  items: [
    { text: "Skills", link: "/pt-BR/guide/skills" },
    { text: "Hooks", link: "/pt-BR/guide/hooks" },
    { text: "Servidores MCP", link: "/pt-BR/guide/mcp-servers" },
    { text: "Plugins", link: "/pt-BR/guide/plugins" },
    { text: "Marketplaces", link: "/pt-BR/guide/marketplaces" },
  ],
};

const portugueseReferenceGroup = {
  text: "Referência",
  collapsed: false,
  items: [
    { text: "Configuração", link: "/pt-BR/reference/configuration" },
    { text: "Comandos", link: "/pt-BR/reference/commands" },
    { text: "Extensões", link: "/pt-BR/reference/extensions" },
  ],
};

const portugueseConceptsGroup = {
  text: "Conceitos",
  collapsed: false,
  items: [
    { text: "Como o Clarvis funciona", link: "/pt-BR/explanation/how-clarvis-works" },
    {
      text: "Escopos e confiança no workspace",
      link: "/pt-BR/explanation/scopes-and-trust",
    },
  ],
};

const portugueseOperationsGroup = {
  text: "Operações e segurança",
  collapsed: false,
  items: [
    { text: "Solução de problemas", link: "/pt-BR/operations/troubleshooting" },
    {
      text: "Compatibilidade do terminal",
      link: "/pt-BR/terminal-compatibility",
    },
    { text: "Segurança", link: "/pt-BR/operations/security" },
  ],
};

const sidebar = [
  gettingStartedGroup,
  guideGroup,
  extensionsGroup,
  referenceGroup,
  conceptsGroup,
  operationsGroup,
];
const portugueseSidebar = [
  portugueseGettingStartedGroup,
  portugueseGuideGroup,
  portugueseExtensionsGroup,
  portugueseReferenceGroup,
  portugueseConceptsGroup,
  portugueseOperationsGroup,
];

const englishThemeConfig: ClarvisThemeConfig = {
  logo: { src: "/logo.svg", alt: "Clarvis" },
  siteTitle: "Clarvis",
  productVersion,
  i18nRouting: true,

  nav: [
    {
      text: "Guide",
      activeMatch:
        "/(getting-started|installation)|/guide/(daily-use|providers-and-models|plans|worktrees|agents|workflows|safety)",
      items: [...gettingStartedGroup.items, ...guideGroup.items],
    },
    {
      text: "Extensions",
      activeMatch: "/guide/(skills|hooks|mcp-servers|plugins|marketplaces)",
      items: extensionsGroup.items,
    },
    { text: "Reference", activeMatch: "/reference/", items: referenceGroup.items },
    { text: "Concepts", activeMatch: "/explanation/", items: conceptsGroup.items },
    {
      text: "Operations",
      activeMatch: "/(operations/|terminal-compatibility)",
      items: operationsGroup.items,
    },
    {
      text: `v${productVersion}`,
      items: [
        { text: "Source", link: repo },
        { text: "License", link: `${repo}/blob/main/LICENSE` },
      ],
    },
  ],

  sidebar: { "/": sidebar },
  outline: { level: [2, 3], label: "On this page" },
  search: {
    provider: "local",
    options: {
      locales: {
        "pt-BR": {
          translations: {
            button: { buttonText: "Buscar", buttonAriaLabel: "Buscar na documentação" },
            modal: {
              displayDetails: "Exibir lista detalhada",
              resetButtonTitle: "Limpar busca",
              backButtonTitle: "Fechar busca",
              noResultsText: "Nenhum resultado encontrado para",
              footer: {
                selectText: "selecionar",
                selectKeyAriaLabel: "Enter",
                navigateText: "navegar",
                navigateUpKeyAriaLabel: "Seta para cima",
                navigateDownKeyAriaLabel: "Seta para baixo",
                closeText: "fechar",
                closeKeyAriaLabel: "Escape",
              },
            },
          },
        },
      },
    },
  },
  externalLinkIcon: true,
  darkModeSwitchLabel: "Appearance",
  lightModeSwitchTitle: "Use light theme",
  darkModeSwitchTitle: "Use dark theme",
  sidebarMenuLabel: "Documentation menu",
  returnToTopLabel: "Return to top",
  langMenuLabel: "Change language",
  skipToContentLabel: "Skip to content",
  docFooter: { prev: "Previous", next: "Next" },

  editLink: {
    pattern: `${repo}/edit/main/docs/:path`,
    text: "Edit this page on GitHub",
  },

  lastUpdated: {
    text: "Last updated",
    formatOptions: { dateStyle: "medium" },
  },

  footer: {
    message: "Released under the MIT License.",
    copyright: "Copyright © 2026 Clarvis",
  },
};

const portugueseThemeConfig: ClarvisThemeConfig = {
  logo: { src: "/logo.svg", alt: "Clarvis" },
  siteTitle: "Clarvis",
  productVersion,
  i18nRouting: true,
  nav: [
    {
      text: "Guia",
      activeMatch:
        "/pt-BR/(getting-started|installation|guide/(daily-use|providers-and-models|plans|worktrees|agents|workflows|safety))",
      items: [...portugueseGettingStartedGroup.items, ...portugueseGuideGroup.items],
    },
    {
      text: "Extensões",
      activeMatch: "/pt-BR/guide/(skills|hooks|mcp-servers|plugins|marketplaces)",
      items: portugueseExtensionsGroup.items,
    },
    {
      text: "Referência",
      activeMatch: "/pt-BR/reference/",
      items: portugueseReferenceGroup.items,
    },
    {
      text: "Conceitos",
      activeMatch: "/pt-BR/explanation/",
      items: portugueseConceptsGroup.items,
    },
    {
      text: "Operações",
      activeMatch: "/pt-BR/(operations/|terminal-compatibility)",
      items: portugueseOperationsGroup.items,
    },
    {
      text: `v${productVersion}`,
      items: [
        { text: "Código-fonte", link: repo },
        { text: "Licença", link: `${repo}/blob/main/LICENSE` },
      ],
    },
  ],
  sidebar: { "/pt-BR/": portugueseSidebar },
  outline: { level: [2, 3], label: "Nesta página" },
  externalLinkIcon: true,
  darkModeSwitchLabel: "Aparência",
  lightModeSwitchTitle: "Usar tema claro",
  darkModeSwitchTitle: "Usar tema escuro",
  sidebarMenuLabel: "Menu da documentação",
  returnToTopLabel: "Voltar ao topo",
  langMenuLabel: "Alterar idioma",
  skipToContentLabel: "Ir para o conteúdo",
  docFooter: { prev: "Anterior", next: "Próxima" },
  editLink: {
    pattern: `${repo}/edit/main/docs/:path`,
    text: "Editar esta página no GitHub",
  },
  lastUpdated: {
    text: "Última atualização",
    formatOptions: { dateStyle: "medium" },
  },
  footer: {
    message: "Publicado sob a licença MIT.",
    copyright: "Copyright © 2026 Clarvis",
  },
  notFound: {
    title: "PÁGINA NÃO ENCONTRADA",
    quote: "O conteúdo solicitado não está disponível neste endereço.",
    linkLabel: "ir para a página inicial",
    linkText: "Voltar ao início",
  },
};

export default defineConfigWithTheme<ClarvisThemeConfig>({
  lang: "en-US",
  title: "Clarvis",
  description: descriptions.en,

  locales: {
    root: { label: "English", lang: "en-US" },
    "pt-BR": {
      label: "Português (Brasil)",
      lang: "pt-BR",
      link: "/pt-BR/",
      description: descriptions["pt-BR"],
      themeConfig: portugueseThemeConfig,
    },
  },

  base: "/",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  srcExclude: ["oss-launch-checklist.md", "**/_partials/**"],

  sitemap: { hostname: site },

  transformPageData(pageData) {
    const page = publicDocsByPath.get(pageData.relativePath);
    if (!page) return;
    pageData.description = page.description;
    pageData.frontmatter.description = page.description;
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(...discoveryHead(page, pageData.lastUpdated));
  },

  transformHead({ page }) {
    return page === "404.md" ? [["meta", { name: "robots", content: "noindex, nofollow" }]] : [];
  },

  buildEnd(siteConfig) {
    generateDiscoveryArtifacts({
      descriptions,
      docsRoot: siteConfig.srcDir,
      outDir: siteConfig.outDir,
      repo,
      site,
    });
  },

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    [
      "meta",
      {
        name: "theme-color",
        content: "#fbfbfd",
        media: "(prefers-color-scheme: light)",
      },
    ],
    [
      "meta",
      {
        name: "theme-color",
        content: "#101017",
        media: "(prefers-color-scheme: dark)",
      },
    ],
    ["meta", { name: "author", content: "Clarvis" }],
    ["meta", { property: "og:site_name", content: "Clarvis" }],
  ],

  themeConfig: englishThemeConfig,
});
