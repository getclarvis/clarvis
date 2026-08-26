import { promises as fs } from "node:fs";
import * as path from "node:path";

import { ensureWorkspaceSubdir } from "@clarvis/paths";
import { bestEffortFileStore } from "./tasks.ts";

export interface FileStoreLayout {
  root: string;
  machineryRoot: string;
  lockDir: string;
  init(): Promise<void>;
}

export function createFileStoreLayout(options: {
  root: string;
  machineryRoot?: string;
  workspaceRoot?: string;
}): FileStoreLayout {
  const machineryRoot = options.machineryRoot ?? options.root;
  const split = machineryRoot !== options.root;
  let initialized: Promise<void> | null = null;

  async function existsAsDirectory(dir: string): Promise<boolean> {
    try {
      return (await fs.stat(dir)).isDirectory();
    } catch {
      return false;
    }
  }

  async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async function discardOrphanedBookkeeping(): Promise<void> {
    for (const dir of [
      path.join(machineryRoot, ".state", "indexed"),
      path.join(machineryRoot, ".journal"),
    ]) {
      await bestEffortFileStore("memory_orphan_bookkeeping_cleanup", () =>
        fs.rm(dir, { recursive: true, force: true }),
      );
    }
  }

  return {
    root: options.root,
    machineryRoot,
    lockDir: path.join(machineryRoot, ".lock"),
    init() {
      initialized ??= (async () => {
        const wikiVanished = split && !(await existsAsDirectory(options.root));
        if (options.workspaceRoot !== undefined) {
          ensureWorkspaceSubdir(options.root, options.workspaceRoot);
        } else {
          await ensureDir(options.root);
        }
        if (split) await ensureDir(machineryRoot);
        if (wikiVanished) await discardOrphanedBookkeeping();
      })();
      return initialized;
    },
  };
}
