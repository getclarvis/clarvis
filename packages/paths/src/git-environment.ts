/** Git environment variables that redirect commands into a parent repository. */
const GIT_REPOSITORY_ENVIRONMENT_NAMES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
]);

/**
 * Copy an environment without Git's repository-local routing and storage variables.
 *
 * @remarks Transport and credential variables remain available. Names compare
 * case-insensitively on Windows, matching that platform's environment semantics.
 */
export function withoutGitRepositoryEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    const comparedName = process.platform === "win32" ? name.toUpperCase() : name;
    if (!GIT_REPOSITORY_ENVIRONMENT_NAMES.has(comparedName)) environment[name] = value;
  }
  return environment;
}
