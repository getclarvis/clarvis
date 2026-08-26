/** Hard structural ceilings shared by settings files and direct run requests. */
export const INPUT_LIMITS = {
  profileNameChars: 128,
  profileDescriptionChars: 4_096,
  profileBasePromptChars: 256 * 1024,
  profileAggregateChars: 8 * 1024 * 1024,
  profileTools: 512,
  profileGrants: 64,
  profileSpawnTargets: 64,
  profileCompactionPromptChars: 64 * 1024,
  toolNameChars: 256,
  mcpArgs: 256,
  mcpMapEntries: 256,
  mcpNameChars: 128,
  mcpCommandChars: 8_192,
  mcpArgChars: 8_192,
  mcpValueChars: 16_384,
  pathChars: 4_096,
  commandPatterns: 256,
  commandPatternChars: 2_048,
  sandboxListEntries: 256,
  marketplaces: 64,
  enabledPlugins: 256,
  providers: 1_000,
} as const;

export function boundedRecord<K extends string, V>(
  value: Record<K, V>,
  maxEntries: number,
): boolean {
  return Object.keys(value).length <= maxEntries;
}
