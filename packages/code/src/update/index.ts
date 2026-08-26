import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { releaseTarget, selectUpdateRelease, type ReleaseTarget } from "../update-contract.ts";
import { downloadReleaseAsset, fetchReleaseRecords, type ReleaseFetch } from "./github-releases.ts";
import {
  activateStagedRelease,
  createUpdateStage,
  extractReleaseArchive,
  managedInstallation,
  removeUpdateStage,
  verifyStagedRelease,
  withUpdateLock,
} from "./installation.ts";

/** Injectable command edges used by tests without weakening the production trust roots. */
export interface UpdateCommandOptions {
  currentVersion: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: ReleaseFetch;
  platform?: NodeJS.Platform;
  architecture?: string;
  apiUrl?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

async function runManagedUpdate(input: {
  currentVersion: string;
  target: ReleaseTarget;
  environment: NodeJS.ProcessEnv;
  fetcher: ReleaseFetch;
  apiUrl?: string;
  stdout: Pick<NodeJS.WriteStream, "write">;
}): Promise<void> {
  const installation = await managedInstallation(
    input.environment,
    input.currentVersion,
    input.target,
  );
  await withUpdateLock(installation.root, async () => {
    const current = await managedInstallation(
      input.environment,
      input.currentVersion,
      input.target,
    );
    const userAgent = `clarvis/${input.currentVersion}`;
    const releases = await fetchReleaseRecords(input.fetcher, userAgent, input.apiUrl);
    const selected = selectUpdateRelease(input.currentVersion, input.target, releases);
    if (selected === undefined) {
      input.stdout.write(`clarvis ${input.currentVersion} is already up to date\n`);
      return;
    }
    const stage = await createUpdateStage(current.versions);
    try {
      const archivePath = join(stage, selected.asset.name);
      await downloadReleaseAsset(input.fetcher, selected.asset, archivePath, userAgent);
      const extraction = join(stage, "extract");
      await mkdir(extraction, { recursive: true, mode: 0o700 });
      const stagedRoot = await extractReleaseArchive(archivePath, extraction);
      await verifyStagedRelease(stagedRoot, {
        version: selected.version,
        target: input.target,
        installRoot: current.root,
      });
      await activateStagedRelease(current, stagedRoot, selected.version, input.target);
      input.stdout.write(
        `updated clarvis ${input.currentVersion} -> ${selected.version}; the next invocation uses the new release\n`,
      );
    } finally {
      await removeUpdateStage(stage);
    }
  });
}

/** Run the explicit self-update command without loading the TUI application graph. */
export async function runUpdateCommand(options: UpdateCommandOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.environment ?? process.env;
  const target = releaseTarget(options.platform, options.architecture);
  if (target === undefined) {
    stderr.write(
      `clarvis update failed: unsupported platform ${options.platform ?? process.platform}/${options.architecture ?? process.arch}\n`,
    );
    return 1;
  }
  try {
    await runManagedUpdate({
      currentVersion: options.currentVersion,
      target,
      environment,
      fetcher: options.fetch ?? globalThis.fetch,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      stdout,
    });
    return 0;
  } catch (error) {
    stderr.write(
      `clarvis update failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
