import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  agentsMarketplaceFile,
  agentsMarketplaceFiles,
  isAgentsMarketplaceFile,
  MARKETPLACE_FILE,
} from "@clarvis/paths";
import { marketplaceSchema, type Marketplace, type MarketplaceEntry } from "@clarvis/kernel/config";
import { errorText } from "./errors.ts";
import type { SettingsAdapter } from "./settings.ts";
import { diagnosticEvent } from "../core/diagnostic-events.ts";
import { gitCloneAsync, validateGitUrl } from "./plugin-install.ts";
import { zodIssueSummary } from "./zod-summary.ts";

/**
 * The ceiling on a marketplace document, matching the plugin manifest ceiling.
 *
 * @remarks A workspace catalog is discovered from the working tree with no
 * operator configuration, so a cloned repository can point this reader at a file
 * it did not write. Every other untrusted plugin document in this stack is read
 * under a byte ceiling; this one is no different for being JSON.
 */
const MAX_MARKETPLACE_BYTES = 2 * 1024 * 1024;

/** One plugin entry from a fetched marketplace, tagged with its source and install state. */
export interface MarketplaceListing extends MarketplaceEntry {
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
 * @returns the document at the root first, then the cross-runtime one, which is
 *   deliberately lower precedence: a source that publishes both is saying the
 *   first is what it means for this host.
 */
function documentsIn(root: string): string[] {
  return [join(root, MARKETPLACE_FILE), agentsMarketplaceFile(root)];
}

/**
 * Errnos that mean "this path does not exist yet", and nothing worse.
 *
 * @remarks The only case for which answering `true` is honest: there is no
 * target, so there is nothing that could be escaping.
 */
const ABSENT_ERRNOS = new Set(["ENOENT", "ENOTDIR"]);

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Whether `target` resolves inside the marketplace root.
 *
 * @param realRoot - the marketplace root, already through `realpath`.
 * @param target - the resolved local source.
 * @returns `true` when `target` is `realRoot`, sits beneath it, or does not
 *   exist yet; `false` when it escapes, and `false` when containment cannot be
 *   decided at all.
 * @remarks Checked after `realpath` because the textual refinement on the path
 *   cannot see a symlink pointing out of the tree.
 *
 *   The two resolutions are attempted separately, and the answer depends on
 *   which one failed and why. This used to be one `try` with an untyped
 *   `catch` answering `true`, which meant `EACCES`, `ELOOP` and `ENAMETOOLONG`
 *   all read as "contained" — and `target` comes from the marketplace document,
 *   so its author could make the resolution fail cheaply (a symlink cycle, an
 *   overlong path) and thereby delete the containment note about their own
 *   listing. The exposure was never installation: `validateGitUrl` refuses a
 *   local path outright and the listing is already `installable: false`. It was
 *   the note, and a note an untrusted party can suppress is not a note.
 *
 *   Failing to resolve `root` is decisive in the other direction: with no
 *   boundary established, nothing can be shown to be inside it.
 */
function staysInside(realRoot: string, target: string): boolean {
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno !== undefined && ABSENT_ERRNOS.has(errno)) return true;
    reportContainmentUnknown(error);
    return false;
  }
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep);
}

/**
 * Note that a local listing's containment could not be decided.
 *
 * @param error - why `realpath` refused to resolve the local source.
 * @remarks Extracted from the `catch` so Bun counts it as its own unit;
 *   `specs/cross-cutting/test-architecture.md` §3.7 records that a `catch` body's line counter is
 *   otherwise satisfied by the enclosing `try`.
 */
function reportContainmentUnknown(error: unknown): void {
  diagnosticEvent(
    "marketplace.containment.unknown",
    { reason: errorText(error), errno: errnoOf(error) ?? "unknown" },
    "warn",
  );
}

/**
 * Note every listing whose local source, once resolved, leaves the marketplace
 * root.
 *
 * @param root - the directory the document was read from.
 * @param marketplace - the parsed catalog, annotated in place.
 * @remarks Only ever adds a note: a local listing is already not installable, so
 *   this is the evidence the operator needs, not a gate.
 */
function confineLocalSources(root: string, marketplace: Marketplace): void {
  const realRoot = realpathSync(root);
  for (const entry of marketplace.plugins) {
    if (entry.installable) continue;
    const target = resolve(root, entry.source);
    if (staysInside(realRoot, target)) continue;
    entry.notes = [
      ...entry.notes,
      `listing '${entry.name}': its local source resolves outside the marketplace root`,
    ];
  }
}

/**
 * Read and validate a marketplace document from disk.
 *
 * @param file - the document's absolute path.
 * @returns the parsed catalog, with local sources confined against the
 *   directory the document was read from.
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
  confineLocalSources(dirname(file), parsed.data);
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
    const found = documentsIn(checkout).find((file) => existsSync(file));
    if (found === undefined) {
      throw new Error(`that repository has no ${MARKETPLACE_FILE} at its root`);
    }
    return readMarketplace(found);
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
 * cross-runtime catalogs `deps.agentsCatalogs` discovers.
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
}): MarketplaceAdapter {
  const results = new Map<string, MarketplaceSource>();
  const discover = deps.agentsCatalogs ?? discoverAgentsCatalogs;
  let discovered: string[] = [];

  const every = (): string[] => [...deps.urls(), ...discovered];

  const read = async (id: string): Promise<Marketplace> =>
    isAgentsMarketplaceFile(id) ? readMarketplace(id) : fetchMarketplace(id);

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
  if (current.includes(url)) {
    return { added: false, message: "that marketplace is already configured" };
  }
  await settings.write("global", { marketplaces: [...current, url] });
  return { added: true, message: `added ${url}` };
}
