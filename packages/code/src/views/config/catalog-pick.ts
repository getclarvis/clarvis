import { cacheModeOf, parseModelRef } from "../../adapters/model-policy.ts";
import type {
  CatalogModel,
  CatalogProvider,
  ModelsCatalog,
} from "../../adapters/models-catalog.ts";
import { fuzzyFilter } from "../../core/fuzzy.ts";
import { glyph } from "../../theme/glyphs.ts";
import { fmtCount } from "../truncate.ts";

interface CatalogRowColumn {
  text: string;
  width: number;
}

/** One row of a {@link CatalogPicker} list: a choice, an explicit journey action, or manual entry. */
export interface CatalogRow {
  id: string;
  label: string;
  haystack: string;
  detail?: string;
  columns?: CatalogRowColumn[];
  added?: boolean;
  /** Marks a journey-control row that advances without representing catalog inventory. */
  action?: boolean;
  manual?: boolean;
}

/** Column width reserved for a row's label before any extra columns. */
export const MODEL_LABEL_WIDTH = 28;

/** The synthetic trailing row offered when a picker allows typing a model id by hand. */
export const MANUAL_ROW: CatalogRow = {
  id: "__manual__",
  get label() {
    return "manual entry" + glyph("ellipsis");
  },
  haystack: "",
  manual: true,
};

/** Builds picker rows listing catalog providers (id, kind, model count). */
export function providerRows(providers: CatalogProvider[]): CatalogRow[] {
  return providers.map((c) => ({
    id: c.id,
    label: c.id,
    haystack: `${c.id} ${c.name} ${c.kind}`,
    detail: `${c.kind} ${glyph("separator")} ${c.models.length} models${c.needsBaseUrl ? " " + glyph("separator") + " custom endpoint required" : ""}`,
  }));
}

const ONBOARDING_PROVIDER_ORDER = [
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "google-generative-ai",
  "groq",
] as const;

/** A small recognition-first provider set for first run, before the full catalog is disclosed. */
export function recommendedProviderRows(providers: CatalogProvider[], limit = 6): CatalogRow[] {
  const rank = new Map<string, number>(ONBOARDING_PROVIDER_ORDER.map((id, index) => [id, index]));
  const recognized = providers
    .filter((provider) => rank.has(provider.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const choices = recognized.length > 0 ? recognized.slice(0, limit) : providers.slice(0, limit);
  return providerRows(choices).map((row) => ({
    ...row,
    detail: `recommended ${glyph("separator")} ${row.detail}`,
  }));
}

const CTX_OUT_WIDTH = 10;
const CAPABILITIES_WIDTH = 7;
const CAPABILITY_ORDER = ["tool_calling", "reasoning", "vision"] as const;
const CAPABILITY_INITIAL: Record<string, string> = {
  tool_calling: "T",
  reasoning: "R",
  vision: "V",
};

/**
 * The cache slot's glyph: `C` for a cache you have to ask for, `c` for one the
 * provider manages, blank when the catalog publishes no cache pricing.
 *
 * @remarks Two glyphs at no extra width, because explicit-vs-implicit is the
 * distinction a user acts on: the first needs the request to carry a marker and
 * the second needs nothing at all. A blank reads as "the catalog did not claim
 * this", exactly as an unsupported capability's blank does — never as "this
 * model has no cache".
 */
const CACHE_INITIAL: Record<string, string> = { explicit: "C", implicit: "c" };

function fmtK(n: number | undefined): string {
  if (n == null) return glyph("emDash");
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  return fmtCount(n);
}

/**
 * Renders the fixed-width capability column.
 *
 * @param caps - the catalog's capability tags for this model.
 * @param cacheMode - the model's derived cache mode.
 * @returns one glyph per slot, space-separated, or an em-dash when the catalog
 *   claimed nothing at all.
 * @remarks The em-dash is decided from **every** slot, not from `caps` alone. A
 *   model with no capability tags but a known cache mode would otherwise lose
 *   its cache glyph to an early return.
 */
function fmtCapabilities(caps: string[] | undefined, cacheMode?: string): string {
  const slots = [
    ...CAPABILITY_ORDER.map((c) => (caps?.includes(c) ? CAPABILITY_INITIAL[c]! : " ")),
    (cacheMode !== undefined ? CACHE_INITIAL[cacheMode] : undefined) ?? " ",
  ];
  if (slots.every((s) => s === " ")) return glyph("emDash");
  return slots.join(" ");
}

/**
 * Builds picker rows for a provider's catalog models, with context/output
 * token columns and capability initials, marking rows already in `existing`.
 */
export function modelRows(models: CatalogModel[], existing: ReadonlySet<string>): CatalogRow[] {
  return models.map((m) => ({
    id: m.modelId,
    label: m.modelId,
    haystack: `${m.modelId} ${m.name ?? ""}`,
    columns: [
      {
        text: `${fmtK(m.context_window_tokens)}/${fmtK(m.max_output_tokens)}`,
        width: CTX_OUT_WIDTH,
      },
      { text: fmtCapabilities(m.capabilities, cacheModeOf(m.cost)), width: CAPABILITIES_WIDTH },
    ],
    added: existing.has(m.modelId),
  }));
}

interface ConfiguredModelsProvider {
  name: string;
  models?: Record<
    string,
    { context_window_tokens?: number; max_output_tokens?: number; capabilities?: string[] }
  >;
}

/**
 * Builds picker rows for the models already configured under each provider
 * (as opposed to the wider catalog), marking `current` as added.
 *
 * @param requireCapability - when given, a model that declares capabilities
 *   *without* this one is withheld: a picker whose field means "a model that
 *   can do X" must not list models that provably cannot.
 * @remarks A model carrying **no** capability data is still offered. `undefined`
 *   means "not known", never "unsupported" — the same rule
 *   {@link knownToLackReasoning} states below, and the same one the engine
 *   follows when it sends images to an uncatalogued model. Filtering those out
 *   would hide every custom openai-compatible entry the catalog has never seen,
 *   including ones that do support the capability.
 */
export function configuredModelRows(
  providers: ConfiguredModelsProvider[],
  current?: string,
  requireCapability?: string,
): CatalogRow[] {
  const out: CatalogRow[] = [];
  for (const p of providers) {
    for (const [id, m] of Object.entries(p.models ?? {})) {
      if (
        requireCapability !== undefined &&
        m.capabilities !== undefined &&
        !m.capabilities.includes(requireCapability)
      ) {
        continue;
      }
      const full = `${p.name}/${id}`;
      out.push({
        id: full,
        label: full,
        haystack: full,
        columns: [
          {
            text: `${fmtK(m.context_window_tokens)}/${fmtK(m.max_output_tokens)}`,
            width: CTX_OUT_WIDTH,
          },
        ],
        added: current === full,
      });
    }
  }
  return out;
}

/**
 * Looks up a configured model's catalog capability tags by its full
 * `provider/modelId` reference.
 *
 * @returns the model's `capabilities` array, or `undefined` when the model (or
 *   its provider) isn't configured, or `modelRef` isn't a well-formed
 *   `provider/modelId` string. Callers must treat `undefined` as "no data
 *   known," never as "unsupported" — most models (e.g. a custom
 *   openai-compatible entry the catalog has never seen) simply carry no
 *   capability data at all.
 */
export function configuredModelCapabilities(
  providers: ConfiguredModelsProvider[],
  modelRef: string | undefined,
): string[] | undefined {
  if (!modelRef) return undefined;
  const { provider: providerName, modelId } = parseModelRef(modelRef);
  return providers.find((p) => p.name === providerName)?.models?.[modelId]?.capabilities;
}

/**
 * True only when a model's capability tags are known and explicitly omit
 * `"reasoning"` — `undefined` (data simply not known) is never treated as
 * unsupported, so a hint built on this never fires for an uncataloged model.
 */
export function knownToLackReasoning(capabilities: string[] | undefined): boolean {
  return capabilities !== undefined && !capabilities.includes("reasoning");
}

/**
 * Fuzzy-filters `rows` by `term`, appending {@link MANUAL_ROW} when `manual`
 * is set so a picker can always offer a manual-entry fallback.
 */
export function filterRows(rows: CatalogRow[], term: string, manual: boolean): CatalogRow[] {
  const matched = fuzzyFilter(rows, term.trim(), (r) => r.haystack);
  return manual ? [...matched, MANUAL_ROW] : matched;
}

/** Whether a models catalog has loaded and lists at least one provider. */
export function catalogReady(catalog: ModelsCatalog | null): boolean {
  return !!catalog && catalog.providers().length > 0;
}
