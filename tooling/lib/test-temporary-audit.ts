import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export interface AuditedCommand {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface AuditedExit {
  code: number;
  signal: NodeJS.Signals | null;
}

export interface TemporaryAuditEvent {
  command: string;
  phase: "result" | "observation" | "containment";
  exit?: AuditedExit;
  remaining?: readonly string[];
  root?: string;
  error?: string;
}

/** An executor error identifies whether its child and dependent processes have settled. */
export class TestCommandExecutionError extends Error {
  constructor(
    message: string,
    readonly settled: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface TemporaryAuditDependencies {
  execute: (command: AuditedCommand) => Promise<AuditedExit>;
  emit: (event: TemporaryAuditEvent) => void;
  parent?: string;
  io?: TemporaryAuditIo;
}

export interface TemporaryAuditIo {
  acquire(parent: string): Promise<string>;
  inspect(root: string): Promise<string[]>;
  remove(root: string): Promise<void>;
}

/** A clean command keeps its status; only a passing command with residue becomes failure. */
export function temporaryAuditExit(exit: AuditedExit, remaining: readonly string[]): AuditedExit {
  return exit.code === 0 && remaining.length > 0 ? { code: 1, signal: null } : exit;
}

async function checkedParent(parent: string): Promise<string> {
  const path = resolve(parent);
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path)
    throw new Error(`temporary audit parent must be a real directory: ${path}`);
  return path;
}

async function remainingEntries(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.map((entry) => entry.name).sort();
}

function realIo(): TemporaryAuditIo {
  let acquired: { root: string; dev: number; ino: number } | undefined;
  const assertIdentity = async (root: string): Promise<void> => {
    const current = await lstat(root);
    if (
      acquired?.root !== root ||
      current.dev !== acquired.dev ||
      current.ino !== acquired.ino ||
      !current.isDirectory() ||
      current.isSymbolicLink()
    )
      throw new Error(`temporary audit area identity changed: ${root}`);
  };
  return {
    async acquire(parent) {
      const root = await mkdtemp(join(await checkedParent(parent), "clarvis-test-audit-"));
      try {
        const { dev, ino } = await lstat(root);
        acquired = { root, dev, ino };
        return root;
      } catch (error) {
        try {
          await rm(root, { recursive: true, force: false });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `temporary audit acquisition cleanup failed: ${root}`,
            { cause: cleanupError },
          );
        }
        throw error;
      }
    },
    async inspect(root) {
      await assertIdentity(root);
      return await remainingEntries(root);
    },
    async remove(root) {
      await assertIdentity(root);
      await rm(root, { recursive: true, force: false });
    },
  };
}

/** Wrap one existing executor call with a separate, exclusive temporary area. */
export async function runTestTemporaryAudit(
  command: AuditedCommand,
  label: string,
  deps: TemporaryAuditDependencies,
): Promise<AuditedExit> {
  const parent = resolve(deps.parent ?? tmpdir());
  const io = deps.io ?? realIo();
  const root = await io.acquire(parent);
  const rel = relative(parent, root);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error(`temporary audit escaped its parent: ${root}`);
  let result: AuditedExit | undefined;
  let failure: unknown;
  let settled = false;
  let remaining: string[] | undefined;
  try {
    const env: NodeJS.ProcessEnv = {
      ...command.env,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      NODE_DISABLE_COMPILE_CACHE: "1",
    };
    delete env.CLARVIS_TEST_HOME_HANDOFF;
    try {
      result = await deps.execute({ ...command, env });
      settled = true;
      deps.emit({ command: label, phase: "result", exit: result });
    } catch (error) {
      failure = error;
      settled = error instanceof TestCommandExecutionError && error.settled;
    }
    if (settled) {
      try {
        remaining = await io.inspect(root);
        deps.emit({
          command: label,
          phase: "observation",
          remaining,
          ...(remaining.length > 0 ? { error: "temporary residue" } : {}),
        });
      } catch (error) {
        failure =
          failure === undefined
            ? error
            : new AggregateError([failure, error], "temporary audit inspection failed");
        deps.emit({ command: label, phase: "observation", root, error: String(error) });
      }
    }
  } finally {
    if (settled) {
      try {
        await io.remove(root);
        deps.emit({ command: label, phase: "containment" });
      } catch (error) {
        failure =
          failure === undefined
            ? error
            : new AggregateError([failure, error], "temporary audit containment failed");
        deps.emit({ command: label, phase: "containment", root, error: String(error) });
      }
    } else {
      deps.emit({
        command: label,
        phase: "containment",
        root,
        error: "dependent process exit unconfirmed; area retained",
      });
    }
  }
  if (failure !== undefined) {
    if (
      failure instanceof TestCommandExecutionError &&
      command.signal.aborted &&
      failure.cause === command.signal.reason
    )
      throw command.signal.reason;
    throw failure;
  }
  if (!settled || result === undefined)
    throw new Error(`temporary audit did not confirm child exit: ${root}`);
  if (remaining === undefined) throw new Error(`temporary audit could not inspect: ${root}`);
  return temporaryAuditExit(result, remaining);
}
