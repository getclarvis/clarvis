/**
 * Resolve one generated call specifier to the package root that owns it.
 *
 * @remarks Package subpaths collapse to their bare root. Filesystem paths, built-ins, URL-like
 *   schemes, and module-internal imports return `undefined` so artifact text cannot escape into a
 *   package-manifest path.
 */
export function runtimePackageName(specifier: string): string | undefined {
  const parts = specifier.split("/");
  const first = parts[0];
  if (
    first === undefined ||
    first.length === 0 ||
    first === "." ||
    first === ".." ||
    first.includes("#") ||
    first.includes("\\") ||
    first.includes(":") ||
    first.includes("?")
  ) {
    return undefined;
  }
  if (!first.startsWith("@")) return first;
  const second = parts[1];
  if (
    first.length === 1 ||
    second === undefined ||
    second.length === 0 ||
    second === "." ||
    second === ".." ||
    second.includes("#") ||
    second.includes("\\") ||
    second.includes(":") ||
    second.includes("?")
  ) {
    return undefined;
  }
  return `${first}/${second}`;
}

/** Refuse a runtime-closure entry unless it is already one exact bare package root. */
export function assertRuntimePackageRoot(name: string): void {
  if (runtimePackageName(name) !== name) {
    throw new Error(`invalid runtime package name: ${JSON.stringify(name)}`);
  }
}

/**
 * Find package roots referenced by calls retained in one generated artifact source.
 *
 * @remarks This is deliberately filesystem-independent. The packaging caller separately requires
 *   each candidate to exist under the installed root before adding it to the runtime closure.
 */
export function runtimePackageCandidates(source: string): string[] {
  const found = new Set<string>();
  const add = (specifier: string | undefined): void => {
    if (specifier === undefined) return;
    const candidate = runtimePackageName(specifier);
    if (candidate !== undefined) found.add(candidate);
  };
  for (const match of source.matchAll(/\b[A-Za-z_$][\w$]*\(["'`]([^"'`]+)["'`]\)/g)) {
    add(match[1]);
  }
  for (const match of source.matchAll(/createRequire\(import\.meta\.url\)\(["']([^"']+)["']\)/g)) {
    add(match[1]);
  }
  return [...found].sort();
}
