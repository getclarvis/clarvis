import type { MemoryProviderConfig } from "./schemas.ts";
import type { MemoryProvider } from "./provider.ts";
import type { Memory } from "./memory-contract.ts";

export interface ProviderResolutionContext {
  wiki?: Memory;
  seedMaxChars: number;
}

export interface ProviderResolutionFailure {
  kind: string;
  reason: string;
}

export type ProviderResolution =
  | { ok: true; provider: MemoryProvider; key: string; seedMaxChars: number }
  | { ok: false; failure: ProviderResolutionFailure };

/** Resolve the built-in wiki for one owner. */
export async function resolveMemoryProvider(
  _config: MemoryProviderConfig | undefined,
  ctx: ProviderResolutionContext,
): Promise<ProviderResolution> {
  if (ctx.wiki === undefined) {
    return {
      ok: false,
      failure: { kind: "wiki", reason: "no wiki is available for this owner" },
    };
  }
  const { wikiMemoryProvider } = await import("./wiki-provider.ts");
  return {
    ok: true,
    provider: wikiMemoryProvider(ctx.wiki),
    key: "wiki:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    seedMaxChars: ctx.seedMaxChars,
  };
}
