import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOME_ENV } from "@clarvis/paths";

/**
 * Point the Clarvis global root at a throwaway directory for the duration of a
 * test process.
 *
 * @remarks
 * Per-workspace machinery — monitor sidecars, shell and tool-result spills, the
 * memory wiki's journal and index queue, the plan lockfiles — resolves under the
 * global root rather than inside the working tree, which is what keeps it out of
 * a user's repository. A suite that creates a temp workspace therefore writes
 * into the *developer's own* `$HOME` unless the root is redirected, and it would
 * leave one directory behind per test workspace ever created.
 *
 * Preloaded rather than done in a fixture because the writers resolve the root
 * from the ambient environment at call time, so nothing a test passes to a
 * helper can redirect them. An already-set value is left alone: a suite that
 * pins the root itself means it deliberately.
 */
if (process.env[HOME_ENV] === undefined || process.env[HOME_ENV].trim() === "") {
  const root = mkdtempSync(join(tmpdir(), "clarvis-test-home-"));
  process.env[HOME_ENV] = root;
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* a live child may still hold a handle; the OS reaps the temp dir */
    }
  });
}
