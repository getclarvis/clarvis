import { readFileSync, statSync } from "node:fs";
import type { ClarvisDirs } from "./agents.ts";
import type { KeySource } from "./provider-secrets.ts";

const MAX_CODE_CONFIG_BYTES = 2 * 1024 * 1024;

function keySourcesAt(path: string | undefined): Record<string, KeySource> {
  if (path === undefined) return {};
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_CODE_CONFIG_BYTES) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { keySources?: unknown };
    if (
      parsed.keySources === null ||
      typeof parsed.keySources !== "object" ||
      Array.isArray(parsed.keySources)
    )
      return {};
    return Object.fromEntries(
      Object.entries(parsed.keySources as Record<string, unknown>).map(([name, value]) => [
        name,
        value === "env" || value === "keyfile" ? value : "auto",
      ]),
    );
  } catch {
    return {};
  }
}

/** Read only the credential-source projection needed to start the kernel in parallel. */
export function readStartupKeySources(dirs: ClarvisDirs): Record<string, KeySource> {
  return {
    ...keySourcesAt(dirs.global.codeConfigFile),
    ...keySourcesAt(dirs.state?.codeConfigFile),
  };
}
