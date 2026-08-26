import {
  activeDiagnosticSession,
  DEFAULT_DIAGNOSTIC_LEVEL,
  installDiagnosticSession,
  type DiagnosticLevel,
  type DiagnosticSession,
} from "../core/diagnostic-events.ts";
import { createDiagnosticSession } from "./diagnostic-session.ts";

/** What the diagnostic channel is doing right now, as a surface can report it. */
export interface DebugSessionStatus {
  open: boolean;
  /** The file being written, present only while `open`. */
  path?: string;
  /** The floor records are kept at, present only while `open`. */
  level?: DiagnosticLevel;
}

/** Opening, retuning and closing the diagnostic channel from inside a running session. */
export interface DebugSessionController {
  status(): DebugSessionStatus;
  /**
   * Open a session, or retune the one already installed.
   *
   * @param level - the floor to record at.
   * @returns the file now being written, the level it records at, and whether
   *   an already-installed session was retuned rather than a new one opened.
   * @remarks `retuned` is what lets the caller say what a *fresh* session does
   *   not carry: the kernel is handed its logger once, at construction, so a
   *   session opened after boot holds this UI's own events and nothing the
   *   kernel writes.
   */
  open(level?: DiagnosticLevel): { path: string; level: DiagnosticLevel; retuned: boolean };
  /**
   * Close the session this controller opened.
   *
   * @returns the path that was closed, or `null` when nothing was open.
   */
  close(): string | null;
  dispose(): void;
}

/** Construction seams, so a test need not write into the real state tree. */
export interface DebugSessionControllerDeps {
  /** The workspace whose machine-local state owns the log. */
  workspace?: string;
  /** Injectable factory; defaults to the real JSONL sink. */
  create?: (level: DiagnosticLevel) => DiagnosticSession;
}

/**
 * Own the process-wide diagnostic session's lifecycle for `/debug`.
 *
 * @param deps - the workspace and an optional session factory.
 * @returns the controller `/debug`, `/debug off` and `/debug <level>` drive.
 * @remarks Re-opening **retunes in place**. A second file would split the
 *   record — the kernel keeps writing into the first, this UI's events move to
 *   the second, and neither is the whole story. A session opened by
 *   `--debug` at boot is *not* this controller's to close — it belongs to the
 *   process's own exit handler — so `close()` reports nothing to close while one
 *   is installed that this controller did not open, and `open()` retunes it
 *   rather than closing a file the boot path still intends to finish.
 */
export function createDebugSessionController(
  deps: DebugSessionControllerDeps = {},
): DebugSessionController {
  const create =
    deps.create ??
    ((level: DiagnosticLevel) => createDiagnosticSession({ workspace: deps.workspace, level }));
  let owned: DiagnosticSession | undefined;
  let uninstall: (() => void) | undefined;

  const release = (): string | null => {
    if (owned === undefined) return null;
    const path = owned.path;
    uninstall?.();
    uninstall = undefined;
    owned.close();
    owned = undefined;
    return path;
  };

  return {
    status: () => {
      const session = activeDiagnosticSession();
      return session === undefined
        ? { open: false }
        : { open: true, path: session.path, level: session.level };
    },
    open: (level = DEFAULT_DIAGNOSTIC_LEVEL) => {
      const installed = activeDiagnosticSession();
      if (installed !== undefined) {
        installed.setLevel(level);
        return { path: installed.path, level: installed.level, retuned: true };
      }
      const session = create(level);
      owned = session;
      uninstall = installDiagnosticSession(session);
      return { path: session.path, level: session.level, retuned: false };
    },
    close: () => release(),
    dispose: () => void release(),
  };
}
