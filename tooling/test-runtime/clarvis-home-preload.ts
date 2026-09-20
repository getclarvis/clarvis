import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { HOME_ENV } from "@clarvis/paths";

const HANDOFF_ENV = "CLARVIS_TEST_HOME_HANDOFF";
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
  const protectedPaths = protectedRoots();
  if (protectedPaths.some((protectedPath) => isWithin(candidate, protectedPath)))
    throw new Error("clarvis_test_home_parent_overlaps_operator_state");
  return candidate;
}

function ownsHandoff(): boolean {
  const root = process.env[HOME_ENV]?.trim();
  return root !== undefined && root.length > 0 && process.env[HANDOFF_ENV] === root;
}

/**
 * Isolate direct Bun test entry from operator state while preserving explicit test
 * child handoff. Production root precedence is unchanged: this only authors the
 * test process environment before code under test resolves its paths.
 */
if (!ownsHandoff()) {
  const root = mkdtempSync(join(safeTemporaryParent(), "clarvis-test-home-"));
  process.env[HOME_ENV] = root;
  process.env[HANDOFF_ENV] = root;
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* A live child may still hold a handle; the owner remains the only cleaner. */
    }
  });
}
