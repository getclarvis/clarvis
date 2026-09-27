import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { HOME_ENV } from "@clarvis/paths";

export const HANDOFF_ENV = "CLARVIS_TEST_HOME_HANDOFF";
const protectedEnvironmentKeys = [
  HOME_ENV,
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

function isWithin(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function protectedRoots(): string[] {
  const home = canonical(homedir());
  return [
    process.env[HOME_ENV]?.trim() || join(home, ".clarvis"),
    ...protectedEnvironmentKeys
      .filter((key) => key !== HOME_ENV)
      .map((key) => process.env[key]?.trim())
      .filter((value): value is string => value !== undefined && value.length > 0),
  ].map(canonical);
}

function safeTemporaryParent(): string {
  const candidate = canonical(tmpdir());
  const info = lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("clarvis_test_home_parent_must_be_a_real_directory");
  if (protectedRoots().some((protectedPath) => isWithin(candidate, protectedPath)))
    throw new Error("clarvis_test_home_parent_overlaps_operator_state");
  return candidate;
}

export interface TestHome {
  root: string;
  owned: boolean;
  cleanup(): void;
}

/** Acquire a test-only root without installing runner hooks or changing the environment. */
export function acquireTestHome(
  remove: typeof rmSync = rmSync,
  environment: NodeJS.ProcessEnv = process.env,
): TestHome {
  const inherited = environment[HOME_ENV]?.trim();
  if (inherited && environment[HANDOFF_ENV] === inherited)
    return { root: inherited, owned: false, cleanup() {} };

  const root = mkdtempSync(join(safeTemporaryParent(), "clarvis-test-home-"));
  let removed = false;
  return {
    root,
    owned: true,
    cleanup() {
      if (removed) return;
      try {
        remove(root, { recursive: true, force: true });
        removed = true;
      } catch (error) {
        throw new Error(`clarvis test home cleanup failed for ${root}`, { cause: error });
      }
    },
  };
}
