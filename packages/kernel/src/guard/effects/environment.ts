import { sandboxCommand } from "@clarvis/tools/sandbox";
import type { GuardContext } from "@clarvis/tools/guard";

/** Environment names that can change executable loading, Git/GitHub targets or configuration. */
const CONTEXT =
  /^(?:GIT_|GH_|GITHUB_|LD_|DYLD_|BASH_FUNC_)|^(?:PATH|HOME|USERPROFILE|SYSTEMROOT|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_CONFIG_DIRS|ENV|BASH_ENV|NODE_OPTIONS|PYTHONPATH|RUBYOPT)$/i;

/** Non-secret process lookup and configuration roots can be recaptured from the actual spawn. */
const ROOTS = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "SystemRoot",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CONFIG_DIRS",
  "GH_CONFIG_DIR",
]);

/** Compare the actual spawn environment with host probes without executing the reviewed command. */
export function resolveEffectEnvironment(
  ctx: GuardContext,
  evidence: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> | undefined {
  try {
    const execution =
      sandboxCommand({
        command: ctx.args.command as string,
        cwd: ctx.config.workspaceRoot,
        workspaceRoot: ctx.config.workspaceRoot,
        gitMetadataPaths: ctx.config.gitMetadataPaths,
        temporaryRoots: ctx.config.temporaryRoots,
        sandbox: ctx.config.sandbox,
        secretEnvNames: ctx.config.secretEnvNames,
        forceBare: ctx.sandboxPermissions === "require_escalated",
      }).options.env ?? {};
    const matches = [...new Set([...Object.keys(execution), ...Object.keys(evidence)])].every(
      (name) =>
        /^(?:GIT|GH)_PAGER$/.test(name) ||
        ROOTS.has(name) ||
        !CONTEXT.test(name) ||
        execution[name] === evidence[name],
    );
    if (!matches) return undefined;
    if ([...ROOTS].every((name) => execution[name] === evidence[name])) return evidence;
    return {
      ...evidence,
      ...Object.fromEntries([...ROOTS].map((name) => [name, execution[name]])),
    };
  } catch {
    return undefined;
  }
}
