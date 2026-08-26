/**
 * Deciding what a hook command inherits from the host environment.
 *
 * @remarks
 * **This is credential hygiene, not a sandbox.** A hook command is
 * operator-authored configuration that runs with the operator's own privileges,
 * reads and writes the workspace, and reaches the network; nothing here changes
 * that, and describing it as isolation would be wrong. The goal is narrower and
 * achievable: the model-provider credentials this run is holding must not reach
 * a subprocess that had no reason to see them.
 *
 * That is also why the filter is a denylist. An allowlist is strictly safer and
 * breaks essentially every real hook - `gh`, `docker`, a corporate proxy, a
 * `direnv` layout all need variables nobody can enumerate in advance. If a real
 * boundary is wanted later, the answer is the sandbox, not a longer regex.
 */
import { extractEnvRefs } from "@clarvis/capability";

/**
 * Variables kept before any deny rule is consulted.
 *
 * @remarks
 * Checked first so that no future denylist entry can accidentally strip
 * something a shell needs in order to be a shell. The toolchain roots are taken
 * from the sandbox's own `TOOLCHAIN_ENV_KEYS`, which is this repository's
 * existing considered answer to "what does a toolchain need".
 *
 * Three groups, and no fourth is admissible. First, what a shell needs to start
 * and behave (`PATH`, `HOME`, `SHELL`, `PWD`, the temp and locale names, `TERM`)
 * plus the Windows equivalents of the same (`SystemRoot`, `COMSPEC`, `PATHEXT`,
 * the profile and app-data roots) — without these the subprocess is not a
 * degraded shell, it is a broken one. Second, the version-manager and toolchain
 * roots, which are what make `bun`, `cargo` or `java` resolvable at all.
 *
 * The third group is empty on purpose: no variable is kept here because a hook
 * is *likely* to want it. Anything not needed to be a shell or to find a
 * toolchain reaches the hook through the denylist's default-allow, where a later
 * rule can still take it away — and that is the property this list must not
 * undermine, since a name promoted here becomes unremovable by any future
 * secret rule.
 */
const KEEP_EXACT = new Set<string>([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TZ",
  "TERM",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "BUN_INSTALL",
  "MISE_DATA_DIR",
  "ASDF_DATA_DIR",
  "NVM_DIR",
  "PYENV_ROOT",
  "RUSTUP_HOME",
  "CARGO_HOME",
  "GOROOT",
  "GOPATH",
  "JAVA_HOME",
  "SDKMAN_DIR",
  "DOTNET_ROOT",
]);

const KEEP_PREFIX = ["LC_"];

/**
 * Names whose shape says "this holds a secret".
 *
 * @remarks
 * A near neighbour of `@clarvis/capability`'s `SENSITIVE_KEY`, which redacts by
 * key name for the same reason and which this package could import today. They
 * stay separate because they are not the same pattern and must not converge:
 * that one redacts a *value* already being logged, so over-matching only costs
 * legibility, and it is left unanchored. This one *drops an environment
 * variable* from a subprocess, so over-matching breaks the hook — hence the
 * anchoring below, and hence the extra families (`auth`, `credentials`,
 * `session`) that a redactor has no reason to carry.
 *
 * The separators are anchored so ordinary words survive - `AUTHOR` is not
 * `AUTHORIZATION`, and `PATH` is not a `PAT`.
 */
const SECRET_NAME =
  /(^|_)(authorization|auth|api[_-]?key|apikey|secret|token|password|passwd|pwd|credential|credentials|session)($|_)|private[_-]?key|access[_-]?key/i;

/** Credential families whose names {@link SECRET_NAME} does not describe. */
const SECRET_PREFIX = [
  "AWS_",
  "AZURE_",
  "GCP_",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_",
  "GITHUB_",
  "GH_",
  "NPM_",
  "DOCKER_",
  "SSH_",
  "GPG_",
  "HF_",
  "VAULT_",
];

/** Inputs to {@link filterHookEnv}. */
export interface EnvFilterOptions {
  /**
   * Exact variable names to drop regardless of shape.
   *
   * @remarks
   * This is the grounded half of the filter and the caller is expected to supply
   * it per run: a provider's key variable is *named* by configuration
   * (`api_key_env`), so the only authoritative list is the one the current run
   * is actually using. A shape-based rule alone would miss a key called
   * `MY_COMPANY_LLM`.
   */
  readonly denyExact?: Iterable<string> | undefined;
  /** Variables to add after filtering; these are never subject to the deny rules. */
  readonly add?: Readonly<Record<string, string>> | undefined;
}

function isSecretName(name: string): boolean {
  if (SECRET_NAME.test(name)) return true;
  const upper = name.toUpperCase();
  return SECRET_PREFIX.some((p) => upper.startsWith(p));
}

/**
 * What {@link filterHookEnv} produced, and how much it withheld.
 *
 * @remarks
 * The counts are returned rather than logged here on purpose. Naming a withheld
 * variable would undo the filter — a denylist derived from `api_key_env` and
 * from MCP `${VAR}` references names exactly the variables that hold this run's
 * credentials — so the only publishable fact is *how many*. Returning it keeps
 * the counting testable and leaves the naming decision where it cannot be made
 * wrongly: nowhere.
 */
export interface FilteredHookEnv {
  /** The environment the child runs with. */
  readonly env: Record<string, string>;
  /** How many variables each rule withheld. Never which. */
  readonly denied: {
    /** Dropped by the caller-supplied exact denylist. */
    readonly exact: number;
    /** Dropped by the name-shape rule. */
    readonly shape: number;
  };
}

/**
 * Builds the environment a hook command runs with.
 *
 * @param source - the host environment to start from.
 * @param opts - the per-run denylist and the variables to add.
 * @returns the environment - a fresh object with `undefined` values dropped,
 *   credentials removed and `opts.add` applied last - plus the per-rule counts
 *   of what was withheld (see {@link FilteredHookEnv}).
 * @remarks
 * Precedence is keep-list, then exact denylist, then name shape. A variable on
 * the keep-list is never dropped, which is what makes the shape rule safe to
 * broaden later. The counts follow that same precedence: a keep-listed variable
 * counts as neither, and a variable the exact list already dropped is never
 * also charged to the shape rule.
 */
export function filterHookEnv(
  source: Readonly<Record<string, string | undefined>>,
  opts: EnvFilterOptions = {},
): FilteredHookEnv {
  const denyExact = new Set(opts.denyExact ?? []);
  const out: Record<string, string> = {};
  let exact = 0;
  let shape = 0;
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (KEEP_EXACT.has(name) || KEEP_PREFIX.some((p) => name.startsWith(p))) {
      out[name] = value;
      continue;
    }
    if (denyExact.has(name)) {
      exact++;
      continue;
    }
    if (isSecretName(name)) {
      shape++;
      continue;
    }
    out[name] = value;
  }
  return { env: { ...out, ...(opts.add ?? {}) }, denied: { exact, shape } };
}

/**
 * Extracts the variable names a `${VAR}` interpolation template refers to.
 *
 * @param template - a configured string that may embed `${NAME}` references.
 * @returns every referenced name, in order of appearance.
 * @remarks
 * Used to widen the per-run denylist: an MCP server's `env` or `headers` entry
 * can carry a credential into the run by reference, and that variable deserves
 * the same treatment as a provider key even though its name may say nothing.
 * Delegates to `@clarvis/capability`'s `extractEnvRefs`, the same pattern
 * `@clarvis/mcp-client` resolves references against - the two must recognize
 * the same syntax, or a credential admitted by one reading could reach a hook
 * subprocess filtered against a narrower one.
 */
export function interpolatedNames(template: string): string[] {
  return extractEnvRefs(template);
}
