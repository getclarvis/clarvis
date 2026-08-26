/** Immutable raw environment supplied to reusable kernel composition. */
export interface KernelEnvironment {
  /** Environment names to values; absent values remain explicit `undefined`. */
  readonly values: Readonly<Record<string, string | undefined>>;
}

/** Source precedence used when resolving one stored secret. */
export type SecretEnvironmentSource = "auto" | "env" | "keyfile";

/**
 * Snapshot an environment record so later caller or process mutations cannot leak in.
 *
 * @param values - raw environment values to copy.
 * @returns a frozen kernel environment.
 */
export function createKernelEnvironment(
  values: Readonly<Record<string, string | undefined>>,
): KernelEnvironment {
  return Object.freeze({ values: Object.freeze({ ...values }) });
}

/**
 * Resolve keyfile secrets into a new environment without mutating the input.
 *
 * @param environment - base environment snapshot.
 * @param keyfile - stored secret name/value pairs.
 * @param sources - per-name precedence policy.
 * @returns a new frozen snapshot carrying the resolved credential values.
 */
export function resolveSecretEnvironment(
  environment: KernelEnvironment,
  keyfile: Readonly<Record<string, string>>,
  sources: Readonly<Record<string, SecretEnvironmentSource>>,
): KernelEnvironment {
  const values: Record<string, string | undefined> = { ...environment.values };
  const managed = new Set([...Object.keys(keyfile), ...Object.keys(sources)]);
  for (const name of managed) {
    const source = sources[name] ?? "auto";
    const environmentValue = environment.values[name];
    const keyfileValue = keyfile[name];
    values[name] =
      source === "env"
        ? environmentValue
        : source === "keyfile"
          ? keyfileValue
          : (environmentValue ?? keyfileValue);
  }
  return createKernelEnvironment(values);
}
