import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  allowedInternalDependenciesFor,
  PACKAGE_ROLES,
  packageDependencyViolation,
  PRODUCT_VERSION_IMPORTERS,
  productLockfileVersionErrors,
  productManifestImportViolation,
  packageRoleOf,
  packageRoleRegistryErrors,
  productVersionPolicyErrors,
  type WorkspaceProductManifest,
  workspacePackageName,
} from "../../lib/package-architecture.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

function workspaceManifests(): WorkspaceProductManifest[] {
  const packagesRoot = join(REPO_ROOT, "packages");
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json")),
    )
    .map((entry) => {
      return JSON.parse(
        readFileSync(join(packagesRoot, entry.name, "package.json"), "utf8"),
      ) as WorkspaceProductManifest;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function workspacePackageNames(): string[] {
  return workspaceManifests().map(({ name }) => name);
}

describe("package architecture policy", () => {
  it("assigns every workspace package exactly one role", () => {
    const packages = workspacePackageNames();
    expect(packages).toHaveLength(18);
    expect(packageRoleRegistryErrors(packages)).toEqual([]);
    expect(Object.keys(PACKAGE_ROLES).sort()).toEqual(packages);
    for (const packageName of packages) expect(packageRoleOf(packageName)).toBeDefined();
  });

  it("normalizes exported subpaths to their workspace package", () => {
    expect(workspacePackageName("@clarvis/kernel/config")).toBe("@clarvis/kernel");
    expect(workspacePackageName("@clarvis/protocol")).toBe("@clarvis/protocol");
    expect(workspacePackageName("solid-js")).toBeUndefined();
  });

  it("allows only the explicitly owned application dependencies", () => {
    expect(allowedInternalDependenciesFor("@clarvis/code")).toEqual([
      "@clarvis/kernel",
      "@clarvis/paths",
      "@clarvis/protocol",
    ]);
    expect(allowedInternalDependenciesFor("@clarvis/server")).toEqual([
      "@clarvis/capability",
      "@clarvis/kernel",
      "@clarvis/paths",
      "@clarvis/protocol",
    ]);
    expect(packageDependencyViolation("@clarvis/code", "@clarvis/loop")).toContain(
      "may not depend",
    );
    expect(packageDependencyViolation("@clarvis/code", "@clarvis/capability")).toContain(
      "does not own",
    );
  });

  it("keeps foundations as leaves and permits only the intentional peer edge", () => {
    expect(packageDependencyViolation("@clarvis/paths", "@clarvis/kernel")).toContain(
      "may not depend",
    );
    expect(packageDependencyViolation("@clarvis/hooks", "@clarvis/tools")).toBeUndefined();
    expect(packageDependencyViolation("@clarvis/tools", "@clarvis/hooks")).toContain(
      "may not depend on peer",
    );
  });

  it("limits engine execution to the capabilities that own it", () => {
    expect(packageDependencyViolation("@clarvis/memory", "@clarvis/loop")).toBeUndefined();
    expect(packageDependencyViolation("@clarvis/workflows", "@clarvis/loop")).toBeUndefined();
    expect(
      packageDependencyViolation("@clarvis/workflows", "@clarvis/supervision"),
    ).toBeUndefined();
    expect(packageDependencyViolation("@clarvis/plan", "@clarvis/loop")).toContain(
      "may not depend",
    );
    expect(packageDependencyViolation("@clarvis/tasks", "@clarvis/tools")).toContain(
      "may not depend",
    );
  });

  it("reports missing and stale registry assignments", () => {
    expect(packageRoleRegistryErrors(["@clarvis/code", "@clarvis/new-package"])).toContain(
      "architecture role missing for @clarvis/new-package",
    );
    expect(packageRoleRegistryErrors(["@clarvis/code"])).toContain(
      "architecture role references unknown workspace package @clarvis/server",
    );
  });

  it("keeps the root manifest as the sole product-version authority", () => {
    const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      version?: unknown;
    };
    const manifests = workspaceManifests();
    expect(productVersionPolicyErrors(rootManifest.version, manifests)).toEqual([]);
    expect(manifests.every((manifest) => manifest.private === true)).toBe(true);
    expect(manifests.every((manifest) => manifest.version === undefined)).toBe(true);
  });

  it("reports invalid product versions and versioned or public workspaces", () => {
    expect(
      productVersionPolicyErrors("next", [
        { name: "@clarvis/private-versioned", private: true, version: "1.2.3" },
        { name: "@clarvis/public", private: false },
      ]),
    ).toEqual([
      "@clarvis/private-versioned: workspace package must not declare version; root package.json owns the product version",
      "@clarvis/public: workspace package must remain private",
      'root package.json: product version must be an exact SemVer, observed "next"',
    ]);
    expect(
      productLockfileVersionErrors([
        { path: "packages/code" },
        { path: "packages/loop", version: "0.0.0" },
      ]),
    ).toEqual(["packages/loop: bun.lock workspace entry must not declare version"]);
  });

  it("limits runtime reads of the root product manifest", () => {
    expect(PRODUCT_VERSION_IMPORTERS).toEqual([
      "packages/code/src/cli-args.ts",
      "packages/loop/src/version.ts",
      "packages/mcp-client/src/version.ts",
      "packages/server/src/version.ts",
    ]);
    for (const sourceFile of PRODUCT_VERSION_IMPORTERS) {
      expect(productManifestImportViolation(sourceFile)).toBeUndefined();
      expect(readFileSync(join(REPO_ROOT, sourceFile), "utf8")).toContain(
        'from "../../../package.json"',
      );
    }
    expect(productManifestImportViolation("packages/code/src/views/App.tsx")).toContain(
      "approved product-version module",
    );
  });
});
