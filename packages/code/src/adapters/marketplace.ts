import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  agentsMarketplaceFile,
  agentsMarketplaceFiles,
  isAgentsMarketplaceFile,
  MARKETPLACE_FILE,
} from "@clarvis/kernel/paths";
import { marketplaceSchema, type Marketplace, type MarketplaceEntry } from "@clarvis/kernel/config";
import { errorText } from "./errors.ts";
import type { SettingsAdapter } from "./settings.ts";
import { gitCloneAsync, validateGitUrl } from "./plugin-install.ts";
import { zodIssueSummary } from "./zod-summary.ts";
import type { PluginInstallSource } from "@clarvis/protocol";

/**
 * The ceiling on a marketplace document, matching the plugin manifest ceiling.
 *
 * @remarks A workspace catalog is discovered from the working tree with no
 * operator configuration, so a cloned repository can point this reader at a file
 * it did not write. Every other untrusted plugin document in this stack is read
 * under a byte ceiling; this one is no different for being JSON.
 */
const MAX_MARKETPLACE_BYTES = 2 * 1024 * 1024;

/** The official catalog included by the Clarvis TUI without a settings write. */
export const OFFICIAL_MARKETPLACE_URL = "https://github.com/getclarvis/marketplace.git";

/** Product-owned catalog sources that precede operator-added and discovered sources. */
const DEFAULT_MARKETPLACE_URLS: readonly string[] = [OFFICIAL_MARKETPLACE_URL];

/** One plugin entry from a fetched marketplace, tagged with its source and install state. */
export interface MarketplaceListing extends MarketplaceEntry {
  /** Exact catalog source identity, independent from its presentation name. */
  marketplaceUrl: string;
  marketplace: string;
  installed: boolean;
}

/** A configured marketplace URL's last fetch outcome: the parsed catalog, or an error. */
export interface MarketplaceSource {
  url: string;
  marketplace?: Marketplace;
  error?: string;
}

/** Fetches and caches configured marketplace catalogs, deduplicating plugin listings across sources. */
export interface MarketplaceAdapter {
  sources: () => MarketplaceSource[];
  listings: () => MarketplaceListing[];
  load: () => Promise<void>;
  refresh: () => void;
}

/**
 * The marketplace documents inside one checkout, in the order they are read.
 *
 * @param root - the checkout root.
 * @returns the shared marketplace document published by the checkout.
 */
function documentsIn(root: string): string[] {
  return [agentsMarketplaceFile(root)];
}

/** Root against which one marketplace document resolves `source.path`. */
function marketplaceRoot(file: string): string {
  return isAgentsMarketplaceFile(file) ? dirname(dirname(dirname(file))) : dirname(file);
}

/**
 * Read and validate a marketplace document from disk.
 *
 * @param file - the document's absolute path.
 * @returns the parsed catalog.
 * @throws {@link Error} when the file is unreadable, is not valid JSON, or is not
 *   a marketplace document at all.
 */
function readMarketplace(file: string): Marketplace {
  let raw: string;
  try {
    const size = statSync(file).size;
    if (size > MAX_MARKETPLACE_BYTES) {
      throw new Error(
        `it is ${String(size)} bytes, past the ${String(MAX_MARKETPLACE_BYTES)}-byte limit`,
      );
    }
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`its ${MARKETPLACE_FILE} could not be read: ${errorText(e)}`, { cause: e });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`its ${MARKETPLACE_FILE} is not valid JSON: ${errorText(e)}`, { cause: e });
  }
  const parsed = marketplaceSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`its ${MARKETPLACE_FILE} is invalid: ${zodIssueSummary(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Clones `url` into a scratch temp directory, reads and validates its
 * marketplace document, then removes the checkout.
 *
 * @throws {@link Error} when the clone publishes no marketplace document, the
 *   document isn't valid JSON, or it fails {@link marketplaceSchema}.
 * @remarks **This runs `git` on the machine `code` is running on**, and it is
 *   the one half of the plugin story that does. Installation goes through
 *   `KernelClient.plugins.install`, whose contract says the plugin service must
 *   be server-side because "a remote UI has no local git or fs"; browsing a
 *   marketplace has no protocol service at all, so it stayed here. Against an
 *   in-process kernel the two are indistinguishable — same machine, same disk —
 *   which is why the split has cost nothing so far.
 *
 *   Against a remote kernel it would split cleanly in the wrong place:
 *   installing a plugin would work and reach the kernel's filesystem, while
 *   adding a marketplace would clone onto the *operator's* laptop and validate a
 *   document describing plugins the kernel will never see. Whether the answer is
 *   a `MarketplaceService` on the protocol, or a decision that catalogs are
 *   deliberately client-side, is not determinable from the code and has not been
 *   made.
 */
async function fetchMarketplace(url: string): Promise<Marketplace> {
  const safe = validateGitUrl(url);
  const staging = mkdtempSync(join(tmpdir(), "clarvis-marketplace-"));
  const checkout = join(staging, "repo");
  try {
    await gitCloneAsync(safe, checkout);
    const found = (
      url === OFFICIAL_MARKETPLACE_URL
        ? [join(checkout, MARKETPLACE_FILE), ...documentsIn(checkout)]
        : documentsIn(checkout)
    ).find((file) => existsSync(file));
    if (found === undefined) {
      throw new Error(`that repository has no ${MARKETPLACE_FILE} in its shared plugin directory`);
    }
    const marketplace = readMarketplace(found);
    for (const entry of marketplace.plugins) {
      if (entry.sourceType !== "local" || !entry.installable) continue;
      const local = resolve(marketplaceRoot(found), entry.source);
      const subdir = relative(checkout, local).split(sep).join("/");
      entry.sourceType = "git";
      entry.source = safe;
      entry.path = subdir;
    }
    return marketplace;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The cross-runtime marketplace documents this host reads without being
 * configured to, at the user and workspace scopes, workspace first.
 *
 * @returns the documents that exist, deduplicated.
 * @remarks Read, never written, and never an error when absent — a scope that
 *   publishes nothing simply contributes nothing.
 */
function discoverAgentsCatalogs(): string[] {
  const { user, workspace } = agentsMarketplaceFiles();
  return [...new Set([workspace, user])].filter((file) => existsSync(file));
}

/**
 * Builds a {@link MarketplaceAdapter} over `deps.urls`/`deps.installed`, plus the
 * official catalog and the cross-runtime catalogs `deps.agentsCatalogs`
 * discovers.
 *
 * @remarks
 * `load()` fetches each source only once — a source that already has a
 * cached `marketplace` (success) is skipped, but one that previously
 * errored is retried, since `refresh()` (which clears the whole cache) is not
 * the only way a transient fetch failure gets another chance.
 */
export function createMarketplaceAdapter(deps: {
  urls: () => string[];
  installed: () => string[];
  agentsCatalogs?: () => string[];
  defaultUrls?: readonly string[];
}): MarketplaceAdapter {
  const results = new Map<string, MarketplaceSource>();
  const discover = deps.agentsCatalogs ?? discoverAgentsCatalogs;
  const defaults = deps.defaultUrls ?? DEFAULT_MARKETPLACE_URLS;
  let discovered: string[] = [];

  const every = (): string[] => [...new Set([...defaults, ...deps.urls(), ...discovered])];

  const read = async (id: string): Promise<Marketplace> => {
    if (!isAgentsMarketplaceFile(id)) return fetchMarketplace(id);
    const marketplace = readMarketplace(id);
    for (const entry of marketplace.plugins) {
      if (entry.sourceType !== "local" || !entry.installable) continue;
      entry.source = resolve(marketplaceRoot(id), entry.source);
      delete entry.path;
    }
    return marketplace;
  };

  return {
    sources: () => every().map((url) => results.get(url) ?? { url }),
    listings: () => {
      const installed = new Set(deps.installed());
      const out: MarketplaceListing[] = [];
      const seen = new Set<string>();
      for (const url of every()) {
        const s = results.get(url);
        if (s?.marketplace === undefined) continue;
        for (const entry of s.marketplace.plugins) {
          const key = `${url}\0${entry.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            ...entry,
            marketplaceUrl: url,
            marketplace: s.marketplace.displayName ?? s.marketplace.name,
            installed: installed.has(entry.name),
          });
        }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    load: async () => {
      discovered = discover();
      await Promise.all(
        every().map(async (url) => {
          if (results.get(url)?.marketplace !== undefined) return;
          try {
            results.set(url, { url, marketplace: await read(url) });
          } catch (e) {
            results.set(url, { url, error: errorText(e) });
          }
        }),
      );
    },
    refresh: () => {
      results.clear();
      discovered = [];
    },
  };
}

/** Project one tolerant marketplace listing into the strict kernel fetch contract. */
export function marketplaceInstallSource(listing: MarketplaceListing): PluginInstallSource {
  if (listing.sourceType === "local") {
    return { kind: "local", path: listing.source, expected_name: listing.name };
  }
  if (listing.sourceType === "npm") {
    return {
      kind: "npm",
      package: listing.source,
      expected_name: listing.name,
      ...(listing.version === undefined ? {} : { version: listing.version }),
      ...(listing.registry === undefined ? {} : { registry: listing.registry }),
    };
  }
  return {
    kind: "git",
    url: listing.source,
    expected_name: listing.name,
    ...(listing.path === undefined ? {} : { subdir: listing.path }),
    ...(listing.ref === undefined ? {} : { ref: listing.ref }),
    ...(listing.sha === undefined ? {} : { sha: listing.sha }),
  };
}

/**
 * Record a marketplace git URL in global settings.
 *
 * @param settings - the settings adapter to read the current list from and
 *   write the extended one back to.
 * @param url - the git URL the operator supplied, already trimmed.
 * @returns what to tell the operator, and whether anything was written.
 *
 * @remarks
 * Configuring a marketplace used to require hand-editing `settings.json` and
 * restarting the kernel — a path the product named nowhere, so the browser was a
 * dead end for anyone who reached it. This is the whole of that step, kept out of
 * the view so it can be exercised directly.
 */
export async function addMarketplaceSource(
  settings: Pick<SettingsAdapter, "read" | "write">,
  url: string,
): Promise<{ added: boolean; message: string }> {
  const current = settings.read("global")?.marketplaces ?? [];
  if (url === OFFICIAL_MARKETPLACE_URL) {
    return { added: false, message: "the official marketplace is already available by default" };
  }
  if (current.includes(url)) {
    return { added: false, message: "that marketplace is already configured" };
  }
  await settings.write("global", { marketplaces: [...current, url] });
  return { added: true, message: `added ${url}` };
}
