/**
 * The single owner of Clarvis's directory vocabulary, and of the filesystem
 * primitives every writer of that vocabulary needs.
 *
 * @remarks
 * Every other package reaches `.clarvis` and `.agents` through this module and
 * never spells either literal itself. That is what keeps the naming conventions
 * — the monitor prefix, the spill prefix, the temp prefix, the ignore lists —
 * from drifting apart across eight packages, which is how a sweeper came to look
 * for files no writer ever produced.
 *
 * Two families sit here for the same reason the names do. The **atomic-write**
 * family (`writeFileAtomic`, `writeFileDurable`, `tmpPathFor` + `isTmpFile`,
 * `writeFileDurableSync`) replaces seven hand-rolled tmp-and-rename copies that had
 * already diverged on the property that matters — one of them raced two
 * processes onto a single temp name — and it is where the `0o700`/`0o600`
 * posture is applied rather than restated. The **resolve** family
 * (`expandHome`, `resolveAgainst`, `resolveWorkspaceDir`) was forked verbatim
 * between the engine and an optional feature package that is structurally
 * forbidden from importing it.
 *
 * The package has no dependencies at all, internal or external, so the leaves of
 * the graph may depend on it without gaining an edge to anything else.
 */
export {
  AGENTS_DIR,
  AGENTS_PLUGINS_DIR,
  CLARVIS_DIR,
  CONTEXT_FILENAMES,
  DIR_MODE,
  FILE_MODE,
  GIT_DIR,
  INTERNAL_SKIP_DIRS,
  MARKETPLACE_FILE,
  TOOL_OUTPUT_PREFIX,
  TOOL_OUTPUT_SUFFIX,
  TMP_GLOB,
  TMP_PREFIX,
} from "./constants.ts";

export { NOOP_PATHS_LOGGER, setPathsLogger, type PathsLogger } from "./diag.ts";

export { globalRoot, workspaceRoot, HOME_ENV, WORKSPACE_ENV, type RootOptions } from "./roots.ts";

export { globalPaths, type GlobalPaths } from "./global.ts";

export { localHostPaths, type LocalHostPaths, type LocalHostPathOptions } from "./local-host.ts";

export {
  configurationRoots,
  configurationPathClass,
  configurationTarget,
  type ConfigurationRoot,
} from "./configuration.ts";

export {
  agentsMarketplaceFile,
  agentsMarketplaceFiles,
  agentsPluginsDir,
  agentsPluginsDirs,
  agentsSkillsDirs,
  agentsWorkspaceDir,
  isAgentsMarketplaceFile,
  workspacePaths,
  type WorkspacePaths,
} from "./workspace.ts";

export {
  ensureWorkspaceLocalDir,
  ensureWorkspaceStateDir,
  isSpillFile,
  workspaceStatePaths,
  workspaceStatePathsFromRoot,
  type WorkspaceStatePaths,
} from "./workspace-state.ts";

export { ensureWorkspaceDir, ensureWorkspaceSubdir, WORKSPACE_GITIGNORE } from "./ensure.ts";
export {
  ownerFromWorkspace,
  ownerSegment,
  workspaceScopeKey,
  worktreeCheckoutRoot,
} from "./roots.ts";

export {
  fsyncDir,
  fsyncDirSync,
  isTmpFile,
  tmpPathFor,
  writeFileAtomic,
  writeFileAtomicSync,
  writeFileDurable,
  writeFileDurableSync,
  type AtomicWriteOptions,
} from "./atomic.ts";

export {
  acquireLocalLease,
  acquireLocalLeaseSync,
  LocalLeaseLostError,
  reclaimLocalLease,
  reclaimLocalLeaseSync,
  type AcquireLocalLeaseOptions,
  type AcquireLocalLeaseSyncOptions,
  type LocalLease,
  type LocalLeaseRecord,
  type LocalLeaseRecoveryOptions,
  type LocalLeaseSync,
} from "./local-lease.ts";

export { expandHome, resolveAgainst, resolveWorkspaceDir } from "./resolve.ts";

export { executableOnPath, resolveCommand } from "./which.ts";

export { withoutGitRepositoryEnvironment } from "./git-environment.ts";

export { sweepGlobalStateArtifacts, sweepSpillDir } from "./housekeeping.ts";
export type { GlobalStateSweepReport } from "./housekeeping.ts";

export {
  SHORT_SCRATCH_BUDGET_BYTES,
  UNIX_SOCKET_PATH_BUDGET_BYTES,
  allocateShortTemporaryRoot,
  ancestorTrust,
  collectAbandonedShortTemporaryRoots,
  shortTemporaryRootCandidates,
  unixSocketPathFits,
  type AncestorTrust,
  type AncestorTrustOptions,
  type AncestorTrustRefusal,
  type ShortTemporaryCandidateOptions,
  type ShortTemporaryRoot,
  type ShortTemporaryRootOptions,
  type ShortTemporarySweepOptions,
  type ShortTemporarySweepReport,
} from "./short-temporaries.ts";
