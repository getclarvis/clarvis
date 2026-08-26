/** Architectural roles ordered from dependency leaves to applications. */
export const PACKAGE_ROLE_ORDER = [
  "foundation",
  "host-contract",
  "execution-service",
  "engine",
  "product-capability",
  "host-implementation",
  "application",
] as const;

/** One semantic role in the Clarvis package dependency policy. */
export type PackageRole = (typeof PACKAGE_ROLE_ORDER)[number];

/** The single role assignment for every Clarvis workspace package. */
export const PACKAGE_ROLES = {
  "@clarvis/capability": "foundation",
  "@clarvis/paths": "foundation",
  "@clarvis/protocol": "host-contract",
  "@clarvis/llm": "execution-service",
  "@clarvis/mcp-client": "execution-service",
  "@clarvis/supervision": "execution-service",
  "@clarvis/trace": "execution-service",
  "@clarvis/tools": "execution-service",
  "@clarvis/hooks": "execution-service",
  "@clarvis/skills": "execution-service",
  "@clarvis/loop": "engine",
  "@clarvis/memory": "product-capability",
  "@clarvis/plan": "product-capability",
  "@clarvis/tasks": "product-capability",
  "@clarvis/workflows": "product-capability",
  "@clarvis/kernel": "host-implementation",
  "@clarvis/code": "application",
  "@clarvis/server": "application",
} as const satisfies Record<string, PackageRole>;

/** Source modules allowed to read the root-owned Clarvis product version at runtime. */
export const PRODUCT_VERSION_IMPORTERS = [
  "packages/code/src/cli-args.ts",
  "packages/loop/src/version.ts",
  "packages/mcp-client/src/version.ts",
  "packages/server/src/version.ts",
] as const;

const PRODUCT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const ROLE_DEPENDENCIES: Readonly<Record<PackageRole, readonly PackageRole[]>> = {
  foundation: [],
  "host-contract": [],
  "execution-service": ["foundation"],
  engine: ["foundation", "execution-service"],
  "product-capability": ["foundation"],
  "host-implementation": [
    "foundation",
    "host-contract",
    "execution-service",
    "engine",
    "product-capability",
  ],
  application: ["host-contract", "host-implementation"],
};

const PACKAGE_EDGE_EXCEPTIONS = new Set([
  "@clarvis/hooks\0@clarvis/tools",
  "@clarvis/memory\0@clarvis/loop",
  "@clarvis/workflows\0@clarvis/loop",
  "@clarvis/workflows\0@clarvis/supervision",
]);

const APPLICATION_FOUNDATIONS: Readonly<Record<string, readonly string[]>> = {
  "@clarvis/code": ["@clarvis/paths"],
  "@clarvis/server": ["@clarvis/capability", "@clarvis/paths"],
};

/** Human-facing plural label used by the generated role-grouped graph. */
export function packageRoleLabel(role: PackageRole): string {
  switch (role) {
    case "foundation":
      return "foundations";
    case "host-contract":
      return "host contracts";
    case "execution-service":
      return "execution services";
    case "engine":
      return "engine";
    case "product-capability":
      return "product capabilities";
    case "host-implementation":
      return "host implementations";
    case "application":
      return "applications";
  }
}

/** Resolve a workspace package's declared architecture role. */
export function packageRoleOf(packageName: string): PackageRole | undefined {
  return (PACKAGE_ROLES as Readonly<Record<string, PackageRole>>)[packageName];
}

/** Reduce an exported Clarvis subpath to its owning workspace package name. */
export function workspacePackageName(specifier: string): string | undefined {
  if (!specifier.startsWith("@clarvis/")) return undefined;
  return specifier.split("/").slice(0, 2).join("/");
}

/**
 * Explain why `consumer -> provider` violates the central role policy.
 *
 * @returns `undefined` when the edge is allowed, otherwise one stable diagnostic.
 */
export function packageDependencyViolation(consumer: string, provider: string): string | undefined {
  if (consumer === provider) return undefined;
  const consumerRole = packageRoleOf(consumer);
  const providerRole = packageRoleOf(provider);
  if (consumerRole === undefined) return `architecture role missing for ${consumer}`;
  if (providerRole === undefined) return `architecture role missing for ${provider}`;

  if (PACKAGE_EDGE_EXCEPTIONS.has(`${consumer}\0${provider}`)) return undefined;

  if (consumerRole === providerRole) {
    return `${consumer} (${consumerRole}) may not depend on peer ${provider} (${providerRole})`;
  }

  if (consumerRole === "application" && providerRole === "foundation") {
    if ((APPLICATION_FOUNDATIONS[consumer] ?? []).includes(provider)) return undefined;
    return `${consumer} (application) does not own foundation dependency ${provider}`;
  }

  if (ROLE_DEPENDENCIES[consumerRole].includes(providerRole)) return undefined;
  return `${consumer} (${consumerRole}) may not depend on ${provider} (${providerRole})`;
}

/** Every package the central policy permits `consumer` to depend on. */
export function allowedInternalDependenciesFor(consumer: string): string[] {
  return Object.keys(PACKAGE_ROLES)
    .filter((provider) => provider !== consumer)
    .filter((provider) => packageDependencyViolation(consumer, provider) === undefined)
    .sort();
}

/** Ensure the registry and the current workspace package set are a bijection. */
export function packageRoleRegistryErrors(workspacePackages: readonly string[]): string[] {
  const current = new Set(workspacePackages);
  const registered = new Set(Object.keys(PACKAGE_ROLES));
  return [
    ...workspacePackages
      .filter((name) => !registered.has(name))
      .map((name) => `architecture role missing for ${name}`),
    ...Object.keys(PACKAGE_ROLES)
      .filter((name) => !current.has(name))
      .map((name) => `architecture role references unknown workspace package ${name}`),
  ].sort();
}

/** Minimal manifest identity needed to enforce the single-version product model. */
export interface WorkspaceProductManifest {
  name: string;
  private?: boolean;
  version?: unknown;
}

/** Workspace lockfile identity needed to reject synthetic package versions. */
export interface WorkspaceProductLockEntry {
  path: string;
  version?: unknown;
}

/** Validate that the root is the sole version authority and every workspace remains private. */
export function productVersionPolicyErrors(
  rootVersion: unknown,
  workspacePackages: readonly WorkspaceProductManifest[],
): string[] {
  const errors: string[] = [];
  if (typeof rootVersion !== "string" || !PRODUCT_VERSION_PATTERN.test(rootVersion)) {
    errors.push(
      `root package.json: product version must be an exact SemVer, observed ${JSON.stringify(rootVersion)}`,
    );
  }
  for (const workspace of workspacePackages) {
    if (workspace.private !== true) {
      errors.push(`${workspace.name}: workspace package must remain private`);
    }
    if (workspace.version !== undefined) {
      errors.push(
        `${workspace.name}: workspace package must not declare version; root package.json owns the product version`,
      );
    }
  }
  return errors.sort();
}

/** Ensure the generated lockfile does not reintroduce per-workspace version metadata. */
export function productLockfileVersionErrors(
  workspaceEntries: readonly WorkspaceProductLockEntry[],
): string[] {
  return workspaceEntries
    .filter((entry) => entry.version !== undefined)
    .map((entry) => `${entry.path}: bun.lock workspace entry must not declare version`)
    .sort();
}

/** Explain an unauthorized runtime import of the root product manifest. */
export function productManifestImportViolation(sourceFile: string): string | undefined {
  return (PRODUCT_VERSION_IMPORTERS as readonly string[]).includes(sourceFile)
    ? undefined
    : `${sourceFile}: root package.json may be imported only by an approved product-version module`;
}
