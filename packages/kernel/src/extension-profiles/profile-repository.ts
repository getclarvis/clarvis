import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  acquireLocalLeaseSync,
  DIR_MODE,
  globalPaths,
  workspacePaths,
  workspaceStatePaths,
  writeFileAtomicSync,
} from "@clarvis/paths";
import type {
  ExtensionProfileApplyResult,
  ExtensionProfileDefinition,
  ExtensionProfileDefinitionView,
  ExtensionProfileRef,
  ExtensionProfileSelectionScope,
  Scope,
} from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import type { SelectedExtensionProfile } from "./profile-resolution.ts";

const MAX_EXTENSION_PROFILE_BYTES = 1024 * 1024;
const MAX_EXTENSION_PROFILES_PER_SCOPE = 128;
const MAX_EXTENSION_PROFILE_DIRECTORY_ENTRIES = 256;
const EXTENSION_PROFILE_LOCK_STALE_MS = 30_000;
export const PROFILE_NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const BUILTIN_REF: ExtensionProfileRef = { scope: "builtin", name: "default" };
const GLOBAL_SELECTION_WORKSPACE_ERROR =
  "a global selection cannot point at a workspace Extension Profile";
const selectionSchema = z
  .object({
    schema_version: z.literal(1),
    extension_profile: z
      .object({
        scope: z.enum(["builtin", "global", "workspace"]),
        name: z.string().regex(PROFILE_NAME_RE),
      })
      .strict(),
  })
  .strict();

export interface ReadDocument {
  raw?: string;
  revision?: string;
  missing?: boolean;
  error?: string;
}

interface DefinitionCatalog {
  names?: string[];
  entries?: number;
  error?: string;
  resourceExhausted?: true;
}

interface ProfileMutation {
  withSelectionLeases<T>(scopes: readonly ExtensionProfileSelectionScope[], operation: () => T): T;
  readDefinition(input: ExtensionProfileRef): ExtensionProfileDefinitionView;
  selectionFromFile(scope: ExtensionProfileSelectionScope): {
    missing?: true;
    ref?: ExtensionProfileRef;
    error?: string;
  };
  selectionRevisions(): Record<ExtensionProfileSelectionScope, string | null>;
  selectionDocument(scope: ExtensionProfileSelectionScope): ReadDocument;
  writeDefinition(ref: { scope: Scope; name: string }, serialized: string): void;
  writeSelection(
    ref: ExtensionProfileRef,
    scope: ExtensionProfileSelectionScope,
  ): ExtensionProfileApplyResult;
  removeSelection(scope: ExtensionProfileSelectionScope): void;
  removeDefinition(ref: { scope: Scope; name: string }): void;
  restoreSelection(scope: ExtensionProfileSelectionScope, before: ReadDocument): void;
  restoreDefinition(ref: { scope: Scope; name: string }, before: ReadDocument): void;
}

export function documentRevision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function assertSelectionTarget(
  scope: ExtensionProfileSelectionScope,
  ref: ExtensionProfileRef,
): void {
  if (scope === "global" && ref.scope === "workspace") {
    throw kernelError("invalid_request", GLOBAL_SELECTION_WORKSPACE_ERROR);
  }
}

/** Read one regular file with a hard byte bound and no final symlink traversal. */
function readBounded(path: string, label: string): ReadDocument {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { error: `${label} is not a regular file` };
    if (stat.size > MAX_EXTENSION_PROFILE_BYTES) {
      return {
        error: `${label} exceeds the ${String(MAX_EXTENSION_PROFILE_BYTES)}-byte resource limit`,
      };
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== bytes.length) return { error: `${label} changed while it was read` };
    const raw = bytes.toString("utf8");
    return { raw, revision: documentRevision(bytes) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { missing: true };
    return { error: `${label} could not be read: ${(error as Error).message}` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function missingDefinitionCatalog(dir: string, materialize: boolean): DefinitionCatalog {
  if (!materialize) return { names: [], entries: 0 };
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    return {
      error: `Extension Profile directory could not be created: ${(error as Error).message}`,
    };
  }
  return definitionNames(dir);
}

/** Keep discovery within the same directory and definition limits as the original manager. */
function definitionNames(dir: string, materializeMissing = false): DefinitionCatalog {
  let opened: ReturnType<typeof opendirSync>;
  try {
    opened = opendirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return missingDefinitionCatalog(dir, materializeMissing);
    if (code === "ENOTDIR") return { names: [], entries: 0 };
    return {
      error: `Extension Profile directory could not be opened: ${(error as Error).message}`,
    };
  }
  const names: string[] = [];
  let entries = 0;
  let scanFailed = false;
  let scanFailure: unknown;
  try {
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > MAX_EXTENSION_PROFILE_DIRECTORY_ENTRIES) {
        return {
          error:
            `Extension Profile directory exceeds the ` +
            `${String(MAX_EXTENSION_PROFILE_DIRECTORY_ENTRIES)}-entry resource limit`,
          resourceExhausted: true,
        };
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const name = entry.name.slice(0, -5);
      if (PROFILE_NAME_RE.test(name)) names.push(name);
    }
  } catch (error) {
    scanFailed = true;
    scanFailure = error;
  } finally {
    opened.closeSync();
  }
  if (scanFailed) {
    const code = (scanFailure as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return missingDefinitionCatalog(dir, materializeMissing);
    if (code === "ENOTDIR") return { names: [], entries: 0 };
    return {
      error: `Extension Profile directory could not be read: ${(scanFailure as Error).message}`,
    };
  }
  if (names.length > MAX_EXTENSION_PROFILES_PER_SCOPE) {
    return {
      error:
        `Extension Profile directory contains more than ` +
        `${String(MAX_EXTENSION_PROFILES_PER_SCOPE)} definitions`,
      resourceExhausted: true,
    };
  }
  return { names: names.sort((left, right) => left.localeCompare(right)), entries };
}

/** Owns all profile document paths, bounded reads and mutation leases. */
export function createProfileRepository(options: {
  globalDir: string;
  workspaceRoot: string;
  validateRef(value: unknown): ExtensionProfileRef;
  parseDefinition(
    ref: ExtensionProfileRef,
    raw: string,
  ): { definition?: ExtensionProfileDefinition; error?: string };
  profileId(ref: ExtensionProfileRef): string;
  /** Fault and ordering seams for repository contract tests. */
  readDocument?: typeof readBounded;
  writeDocument?: (path: string, data: string) => void;
  acquireLease?: (path: string, staleMs: number) => { release(): boolean } | null;
}) {
  const readDocument = options.readDocument ?? readBounded;
  const writeDocument = options.writeDocument ?? writeFileAtomicSync;
  const acquireLease =
    options.acquireLease ??
    ((path: string, staleMs: number) => acquireLocalLeaseSync(path, { staleMs }));
  const global = globalPaths(options.globalDir);
  const workspace = workspacePaths(options.workspaceRoot);
  const workspaceState = workspaceStatePaths(options.workspaceRoot, {
    env: { CLARVIS_HOME: options.globalDir },
  });
  const definitionDir = (scope: Scope): string =>
    scope === "global" ? global.extensionProfilesDir : workspace.extensionProfilesDir;
  const definitionPath = (ref: ExtensionProfileRef): string | undefined =>
    ref.scope === "builtin" ? undefined : join(definitionDir(ref.scope), `${ref.name}.json`);
  const selectionPath = (scope: ExtensionProfileSelectionScope): string =>
    scope === "global"
      ? global.extensionProfileSelectionFile
      : workspaceState.extensionProfileSelectionFile;
  const definitionDocument = (ref: ExtensionProfileRef): ReadDocument =>
    readDocument(definitionPath(ref)!, `Extension Profile '${options.profileId(ref)}'`);
  const selectionDocument = (scope: ExtensionProfileSelectionScope): ReadDocument =>
    readDocument(selectionPath(scope), `${scope} Extension Profile selection`);

  const readDefinition = (input: ExtensionProfileRef): ExtensionProfileDefinitionView => {
    const ref = options.validateRef(input);
    if (ref.scope === "builtin") return { ref: BUILTIN_REF, immutable: true };
    const document = definitionDocument(ref);
    if (document.missing === true) {
      return {
        ref,
        immutable: false,
        error: `Extension Profile '${options.profileId(ref)}' does not exist`,
      };
    }
    if (document.raw === undefined) {
      return {
        ref,
        immutable: false,
        error: document.error ?? "Extension Profile could not be read",
      };
    }
    const parsed = options.parseDefinition(ref, document.raw);
    return {
      ref,
      immutable: false,
      ...(document.revision === undefined ? {} : { revision: document.revision }),
      ...(parsed.definition === undefined ? {} : { definition: parsed.definition }),
      ...(parsed.error === undefined ? {} : { error: parsed.error }),
    };
  };

  const selectionFromFile = (
    scope: ExtensionProfileSelectionScope,
  ): { missing?: true; ref?: ExtensionProfileRef; error?: string } => {
    const document = selectionDocument(scope);
    if (document.missing === true) return { missing: true };
    if (document.raw === undefined)
      return { error: document.error ?? "selection could not be read" };
    let json: unknown;
    try {
      json = JSON.parse(document.raw);
    } catch (error) {
      return { error: `invalid JSON: ${(error as Error).message}` };
    }
    const parsed = selectionSchema.safeParse(json);
    if (!parsed.success) return { error: z.prettifyError(parsed.error) };
    const ref = parsed.data.extension_profile;
    if (ref.scope === "builtin" && ref.name !== BUILTIN_REF.name) {
      return { error: `unknown builtin Extension Profile '${ref.name}'` };
    }
    if (scope === "global" && ref.scope === "workspace") {
      return { error: GLOBAL_SELECTION_WORKSPACE_ERROR };
    }
    return { ref };
  };

  const selectionRevision = (scope: ExtensionProfileSelectionScope): string | null => {
    const document = selectionDocument(scope);
    if (document.missing === true) return null;
    if (document.revision !== undefined) return document.revision;
    throw kernelError("unavailable", document.error ?? `${scope} selection could not be read`);
  };
  const selectionRevisions = (): Record<ExtensionProfileSelectionScope, string | null> => ({
    global: selectionRevision("global"),
    workspace: selectionRevision("workspace"),
  });

  const assertExpectedDefinition = (
    ref: { scope: Scope; name: string },
    expectedRevision: string | null,
    current: ReadDocument,
  ): void => {
    if (expectedRevision === null) {
      if (current.missing === true) return;
      if (current.revision !== undefined) {
        throw kernelError(
          "conflict",
          `Extension Profile '${options.profileId(ref)}' already exists`,
        );
      }
      throw kernelError(
        "unavailable",
        current.error ?? `Extension Profile '${options.profileId(ref)}' could not be inspected`,
      );
    }
    if (current.revision !== expectedRevision) {
      throw kernelError("conflict", "Extension Profile changed since it was read", {
        expected_revision: expectedRevision,
        actual_revision: current.revision ?? null,
      });
    }
  };

  const assertCatalogCapacity = (scope: Scope): void => {
    const catalog = definitionNames(definitionDir(scope));
    if (catalog.error !== undefined) {
      throw kernelError(
        catalog.resourceExhausted === true ? "resource_exhausted" : "unavailable",
        catalog.error,
      );
    }
    if (
      (catalog.names?.length ?? 0) >= MAX_EXTENSION_PROFILES_PER_SCOPE ||
      (catalog.entries ?? 0) >= MAX_EXTENSION_PROFILE_DIRECTORY_ENTRIES
    ) {
      throw kernelError(
        "resource_exhausted",
        `Extension Profile catalog '${scope}' has reached its definition or entry limit`,
        {
          definitions: catalog.names?.length ?? 0,
          definition_limit: MAX_EXTENSION_PROFILES_PER_SCOPE,
          entries: catalog.entries ?? 0,
          entry_limit: MAX_EXTENSION_PROFILE_DIRECTORY_ENTRIES,
        },
      );
    }
  };

  /** Retain the crash-recoverable local lease through async callbacks and rollback. */
  const underLease = <T>(path: string, label: string, operation: () => T): T => {
    const lease = acquireLease(`${path}.lock`, EXTENSION_PROFILE_LOCK_STALE_MS);
    if (lease === null)
      throw kernelError("conflict", `${label} is being changed by another process`);
    try {
      const result = operation();
      if (result instanceof Promise) return result.finally(() => lease.release()) as T;
      lease.release();
      return result;
    } catch (error) {
      lease.release();
      throw error;
    }
  };

  const underSelectionLeases = <T>(
    scopes: readonly ExtensionProfileSelectionScope[],
    operation: () => T,
  ): T => {
    const ordered = [...new Set(scopes)].sort((left, right) => left.localeCompare(right));
    const run = (index: number): T => {
      const scope = ordered[index];
      if (scope === undefined) return operation();
      return underLease(selectionPath(scope), `${scope} Extension Profile selection`, () =>
        run(index + 1),
      );
    };
    return run(0);
  };

  const underDefinitionLease = <T>(selection: SelectedExtensionProfile, operation: () => T): T => {
    if (selection.error !== undefined || selection.ref.scope === "builtin") return operation();
    return underLease(
      definitionPath(selection.ref)!,
      `Extension Profile '${options.profileId(selection.ref)}'`,
      operation,
    );
  };

  const withTransaction = <T>(
    definitionRef: { scope: Scope; name: string } | undefined,
    initialSelections: readonly ExtensionProfileSelectionScope[],
    operation: (transaction: ProfileMutation) => T,
  ): T => {
    let active = true;
    const selections = new Set(initialSelections);
    const assertActive = (): void => {
      if (!active) throw kernelError("unavailable", "Extension Profile mutation lease has ended");
    };
    const assertDefinition = (ref: { scope: Scope; name: string }): void => {
      assertActive();
      if (
        definitionRef === undefined ||
        definitionRef.scope !== ref.scope ||
        definitionRef.name !== ref.name
      )
        throw kernelError("unavailable", "Extension Profile definition lease is not held");
    };
    const assertSelection = (scope: ExtensionProfileSelectionScope): void => {
      assertActive();
      if (!selections.has(scope))
        throw kernelError("unavailable", "Extension Profile selection lease is not held");
    };
    const tx: ProfileMutation = {
      withSelectionLeases<U>(
        scopes: readonly ExtensionProfileSelectionScope[],
        callback: () => U,
      ): U {
        assertActive();
        return underSelectionLeases(scopes, () => {
          const newlyHeld = scopes.filter((scope) => !selections.has(scope));
          for (const scope of newlyHeld) selections.add(scope);
          const release = (): void => {
            for (const scope of newlyHeld) selections.delete(scope);
          };
          try {
            const result = callback();
            if (result instanceof Promise) return result.finally(release) as U;
            release();
            return result;
          } catch (error) {
            release();
            throw error;
          }
        });
      },
      readDefinition,
      selectionFromFile,
      selectionRevisions,
      selectionDocument,
      writeDefinition(ref, serialized): void {
        assertDefinition(ref);
        writeDocument(definitionPath(ref)!, serialized);
      },
      writeSelection(ref, scope): ExtensionProfileApplyResult {
        assertSelection(scope);
        assertSelectionTarget(scope, ref);
        writeDocument(
          selectionPath(scope),
          `${JSON.stringify({ schema_version: 1, extension_profile: ref }, null, 2)}\n`,
        );
        return { selected: ref, reconnect_required: true };
      },
      removeSelection(scope): void {
        assertSelection(scope);
        rmSync(selectionPath(scope), { force: true });
      },
      removeDefinition(ref): void {
        assertDefinition(ref);
        rmSync(definitionPath(ref)!);
      },
      restoreSelection(scope, before): void {
        assertSelection(scope);
        if (before.missing === true) {
          rmSync(selectionPath(scope), { force: true });
          return;
        }
        if (before.raw === undefined) {
          throw kernelError(
            "unavailable",
            "the previous Extension Profile selection cannot be restored",
          );
        }
        writeDocument(selectionPath(scope), before.raw);
      },
      restoreDefinition(ref, before): void {
        assertDefinition(ref);
        const path = definitionPath(ref)!;
        if (before.missing === true) {
          rmSync(path, { force: true });
          return;
        }
        if (before.raw === undefined) {
          throw kernelError(
            "unavailable",
            "the previous Extension Profile definition cannot be restored",
          );
        }
        writeDocument(path, before.raw);
      },
    };
    try {
      const result = operation(tx);
      if (result instanceof Promise)
        return result.finally(() => {
          active = false;
        }) as T;
      active = false;
      return result;
    } catch (error) {
      active = false;
      throw error;
    }
  };

  return {
    readDefinition,
    selectionFromFile,
    selectionRevisions,
    definitionDocument,
    assertExpectedDefinition,
    assertCatalogCapacity,
    definitionExists(ref: ExtensionProfileRef): boolean {
      return definitionDocument(ref).missing !== true;
    },
    listDefinitions(): ExtensionProfileDefinitionView[] {
      const out: ExtensionProfileDefinitionView[] = [{ ref: BUILTIN_REF, immutable: true }];
      for (const scope of ["global", "workspace"] as const) {
        const listed = definitionNames(definitionDir(scope), scope === "global");
        if (listed.error !== undefined) {
          out.push({
            ref: { scope, name: "invalid-directory" },
            immutable: false,
            error: listed.error,
          });
          continue;
        }
        for (const name of listed.names ?? []) out.push(readDefinition({ scope, name }));
      }
      return out;
    },
    withDefinitionMutation<T>(
      ref: { scope: Scope; name: string },
      expectedRevision: string | null,
      operation: (before: ReadDocument, transaction: ProfileMutation) => T,
    ): T {
      const mutate = (): T =>
        underDefinitionLease({ ref, origin: ref.scope }, () => {
          const current = definitionDocument(ref);
          assertExpectedDefinition(ref, expectedRevision, current);
          if (expectedRevision === null) assertCatalogCapacity(ref.scope);
          return withTransaction(ref, [], (tx) => operation(current, tx));
        });
      return expectedRevision === null
        ? underLease(definitionDir(ref.scope), `${ref.scope} Extension Profile catalog`, mutate)
        : mutate();
    },
    withSelectedMutation<T>(
      selection: SelectedExtensionProfile,
      operation: (transaction: ProfileMutation) => T,
    ): T {
      return underDefinitionLease(selection, () =>
        underSelectionLeases(["global", "workspace"], () =>
          withTransaction(
            selection.error === undefined && selection.ref.scope !== "builtin"
              ? { scope: selection.ref.scope, name: selection.ref.name }
              : undefined,
            ["global", "workspace"],
            operation,
          ),
        ),
      );
    },
  };
}
