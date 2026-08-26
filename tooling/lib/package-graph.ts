import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  PACKAGE_ROLE_ORDER,
  packageDependencyViolation,
  packageRoleLabel,
  packageRoleOf,
  packageRoleRegistryErrors,
  productLockfileVersionErrors,
  productManifestImportViolation,
  productVersionPolicyErrors,
  workspacePackageName,
} from "./package-architecture.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SOURCE_TREES = ["src", "tests", "tooling"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function posix(path) {
  return path.split(sep).join("/");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readJsonc(file) {
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
  if (parsed.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  }
  return parsed.config;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (SOURCE_EXTENSIONS.has(extname(name))) out.push(path);
  }
  return out;
}

function workspaceDirs(root, patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      dirs.push(resolve(root, pattern));
      continue;
    }
    const parent = resolve(root, pattern.slice(0, -2));
    for (const name of readdirSync(parent).sort()) {
      const dir = join(parent, name);
      if (existsSync(join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs;
}

function importIsTypeOnly(node) {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function exportIsTypeOnly(node) {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  );
}

/** Parse every module edge in one source file through the TypeScript AST. */
export function parseModuleEdges(source, fileName = "source.ts") {
  const extension = extname(fileName);
  const kind =
    extension === ".tsx"
      ? ts.ScriptKind.TSX
      : extension === ".jsx"
        ? ts.ScriptKind.JSX
        : extension === ".js" || extension === ".mjs" || extension === ".cjs"
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const edges = [];
  const add = (specifier, edgeKind, typeOnly, node) => {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    edges.push({ specifier, kind: edgeKind, typeOnly, line: start.line + 1 });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, "static", importIsTypeOnly(node), node);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, "static", exportIsTypeOnly(node), node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, "static", node.isTypeOnly, node);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      add(node.arguments[0].text, "dynamic", false, node);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      add(node.arguments[0].text, "static", false, node);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      add(node.argument.literal.text, "static", true, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edges;
}

function requestedSubpath(specifier, packageName) {
  return specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
}

const RUNTIME_EXPORT_CONDITIONS = new Set(["bun", "import", "require", "default"]);
const TYPE_EXPORT_CONDITIONS = new Set([...RUNTIME_EXPORT_CONDITIONS, "types"]);

function exportTargetSupports(target, typeOnly) {
  if (typeof target === "string") return true;
  if (Array.isArray(target)) return target.some((entry) => exportTargetSupports(entry, typeOnly));
  if (target === null || typeof target !== "object") return false;
  const supported = typeOnly ? TYPE_EXPORT_CONDITIONS : RUNTIME_EXPORT_CONDITIONS;
  return Object.entries(target).some(
    ([condition, value]) => supported.has(condition) && exportTargetSupports(value, typeOnly),
  );
}

function subpathMatches(pattern, subpath) {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === subpath;
  return subpath.startsWith(pattern.slice(0, star)) && subpath.endsWith(pattern.slice(star + 1));
}

function exportForSubpath(exportsField, subpath) {
  if (exportsField === undefined || exportsField === null) return undefined;
  if (typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return subpath === "." ? exportsField : undefined;
  }
  const entries = Object.entries(exportsField);
  const isSubpathMap = entries.some(([key]) => key.startsWith("."));
  if (!isSubpathMap) return subpath === "." ? exportsField : undefined;
  const exact = exportsField[subpath];
  if (exact !== undefined) return exact;
  return entries.find(([key]) => key.includes("*") && subpathMatches(key, subpath))?.[1];
}

function runtimeExportTarget(target) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const entry of target) {
      const resolved = runtimeExportTarget(entry);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (target === null || typeof target !== "object") return undefined;
  for (const condition of RUNTIME_EXPORT_CONDITIONS) {
    const resolved = runtimeExportTarget(target[condition]);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function sourceModuleTarget(candidate) {
  const choices = [candidate];
  const extension = extname(candidate);
  if (extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
    const stem = candidate.slice(0, -extension.length);
    choices.push(`${stem}.ts`, `${stem}.tsx`);
  } else if (extension === "") {
    choices.push(
      `${candidate}.ts`,
      `${candidate}.tsx`,
      join(candidate, "index.ts"),
      join(candidate, "index.tsx"),
    );
  }
  return choices.find((file) => existsSync(file) && statSync(file).isFile());
}

function localModuleTarget(pkg, importer, specifier) {
  if (specifier.startsWith(".")) return sourceModuleTarget(resolve(dirname(importer), specifier));
  if (workspacePackageName(specifier) !== pkg.name) return undefined;
  const subpath = requestedSubpath(specifier, pkg.name);
  const exported = exportForSubpath(pkg.manifest.exports, subpath);
  const target = runtimeExportTarget(exported);
  return target === undefined ? undefined : sourceModuleTarget(resolve(pkg.dir, target));
}

function isSubpathExported(manifest, subpath, typeOnly) {
  return exportTargetSupports(exportForSubpath(manifest.exports, subpath), typeOnly);
}

function referenceNames(pkg, byDir): Set<string> | null {
  const file = join(pkg.dir, "tsconfig.build.json");
  if (!existsSync(file)) return null;
  const config = readJsonc(file);
  return new Set<string>(
    (config.references ?? []).map(({ path }) => {
      const resolved = resolve(pkg.dir, path);
      const target = extname(resolved) === ".json" ? dirname(resolved) : resolved;
      const found = byDir.get(target);
      return found?.name ?? `?${posix(relative(pkg.dir, target))}`;
    }),
  );
}

function adjacencyFrom(packages, predicate): Map<string, Set<string>> {
  const names = new Set(packages.map((pkg) => pkg.name));
  return new Map(
    packages.map((pkg) => [
      pkg.name,
      new Set<string>(
        pkg.sourceEdges
          .filter(predicate)
          .map((edge) => workspacePackageName(edge.specifier))
          .filter((name) => name !== undefined && name !== pkg.name && names.has(name)),
      ),
    ]),
  );
}

function reachableFrom(start, adjacency) {
  const reached = new Set();
  const queue = [...(adjacency.get(start) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === start || reached.has(current)) continue;
    reached.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  return [...reached].sort();
}

function dynamicReachableFrom(start, eager, dynamic) {
  const reached = new Set();
  const seen = new Set([`${start}:false`]);
  const queue = [[start, false]];
  while (queue.length > 0) {
    const [current, crossedDynamic] = queue.shift();
    for (const next of eager.get(current) ?? []) {
      const key = `${next}:${crossedDynamic}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (crossedDynamic && next !== start) reached.add(next);
      queue.push([next, crossedDynamic]);
    }
    for (const next of dynamic.get(current) ?? []) {
      const key = `${next}:true`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (next !== start) reached.add(next);
      queue.push([next, true]);
    }
  }
  return [...reached].sort();
}

function stronglyConnectedComponents(names, adjacency) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const components = [];
  const visit = (name) => {
    indices.set(name, index);
    low.set(name, index++);
    stack.push(name);
    onStack.add(name);
    for (const next of adjacency.get(name) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(name, Math.min(low.get(name), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(name, Math.min(low.get(name), indices.get(next)));
      }
    }
    if (low.get(name) !== indices.get(name)) return;
    const component = [];
    for (;;) {
      const value = stack.pop();
      onStack.delete(value);
      component.push(value);
      if (value === name) break;
    }
    if (component.length > 1 || (adjacency.get(name) ?? new Set()).has(name)) {
      components.push(component.sort());
    }
  };
  for (const name of names) if (!indices.has(name)) visit(name);
  return components.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Analyze workspace topology, source edges, export maps, TS references and package roles. */
export function analyzePackageGraph(root: string, options: { enforceArchitecture?: boolean } = {}) {
  const enforceArchitecture = options.enforceArchitecture ?? true;
  const repoRoot = resolve(root);
  const rootManifest = readJson(join(repoRoot, "package.json"));
  const lockfilePath = join(repoRoot, "bun.lock");
  const lockfile = existsSync(lockfilePath) ? readJsonc(lockfilePath) : undefined;
  const packages = workspaceDirs(repoRoot, rootManifest.workspaces ?? [])
    .map((dir) => {
      const manifest = readJson(join(dir, "package.json"));
      const declaredByField = Object.fromEntries(
        DEP_FIELDS.map((field) => [
          field,
          new Set(
            Object.keys(manifest[field] ?? {}).filter((name) => name.startsWith("@clarvis/")),
          ),
        ]),
      );
      return {
        name: manifest.name,
        dir,
        relDir: posix(relative(repoRoot, dir)),
        manifest,
        declaredByField,
        declared: new Set(DEP_FIELDS.flatMap((field) => [...declaredByField[field]])),
        runtimeDeclared: new Set([
          ...declaredByField.dependencies,
          ...declaredByField.optionalDependencies,
        ]),
        sourceEdges: [],
        moduleEdges: [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const byDir = new Map(packages.map((pkg) => [pkg.dir, pkg]));
  const errors = enforceArchitecture
    ? [
        ...packageRoleRegistryErrors(packages.map((pkg) => pkg.name)),
        ...productVersionPolicyErrors(
          rootManifest.version,
          packages.map((pkg) => pkg.manifest),
        ),
        ...productLockfileVersionErrors(
          Object.entries(lockfile?.workspaces ?? {})
            .filter(([path]) => path !== "")
            .map(([path, entry]) => ({
              path,
              version: (entry as { version?: unknown }).version,
            })),
        ),
      ]
    : [];

  for (const pkg of packages) {
    for (const tree of SOURCE_TREES) {
      for (const file of walk(join(pkg.dir, tree))) {
        for (const edge of parseModuleEdges(readFileSync(file, "utf8"), file)) {
          const sourceEdge = {
            ...edge,
            sourceTree: tree,
            file: posix(relative(repoRoot, file)),
          };
          pkg.sourceEdges.push(sourceEdge);
          const internal = workspacePackageName(edge.specifier);
          if (internal !== undefined) {
            const target = byName.get(internal);
            if (target === undefined) {
              errors.push(`${sourceEdge.file}:${edge.line}: unknown workspace package ${internal}`);
            } else {
              if (
                internal === pkg.name &&
                sourceEdge.sourceTree === "src" &&
                requestedSubpath(edge.specifier, internal) === "."
              ) {
                errors.push(
                  `${sourceEdge.file}:${edge.line}: source imports its own public entrypoint ${internal}`,
                );
              }
              if (internal !== pkg.name && !pkg.declared.has(internal)) {
                errors.push(
                  `${pkg.name}: imports undeclared dependency ${internal} at ${sourceEdge.file}:${edge.line}`,
                );
                const violation = enforceArchitecture
                  ? packageDependencyViolation(pkg.name, internal)
                  : undefined;
                if (violation !== undefined)
                  errors.push(`${sourceEdge.file}:${edge.line}: ${violation}`);
              } else if (
                internal !== pkg.name &&
                sourceEdge.sourceTree === "src" &&
                !edge.typeOnly &&
                !pkg.runtimeDeclared.has(internal)
              ) {
                errors.push(
                  `${pkg.name}: imports runtime dependency ${internal} from ${sourceEdge.file}:${edge.line}, but it is declared only for development`,
                );
              }
              const subpath = requestedSubpath(edge.specifier, internal);
              if (!isSubpathExported(target.manifest, subpath, edge.typeOnly)) {
                errors.push(
                  `${sourceEdge.file}:${edge.line}: ${edge.specifier} is not exported by ${internal}`,
                );
              }
            }
          } else if (edge.specifier.startsWith(".")) {
            const target = resolve(dirname(file), edge.specifier);
            if (enforceArchitecture && target === join(repoRoot, "package.json")) {
              const violation = productManifestImportViolation(sourceEdge.file);
              if (violation !== undefined) errors.push(violation);
            }
            const targetPackage = packages.find(
              (candidate) => target === candidate.dir || target.startsWith(candidate.dir + sep),
            );
            if (targetPackage !== undefined && targetPackage.name !== pkg.name) {
              errors.push(
                `${sourceEdge.file}:${edge.line}: relative import crosses into ${targetPackage.name}`,
              );
            }
          }
          if (sourceEdge.sourceTree === "src" && !edge.typeOnly) {
            const target = localModuleTarget(pkg, file, edge.specifier);
            if (
              target !== undefined &&
              (target === join(pkg.dir, "src") || target.startsWith(join(pkg.dir, "src") + sep))
            ) {
              pkg.moduleEdges.push({ from: file, to: target });
              const rootEntry = runtimeExportTarget(exportForSubpath(pkg.manifest.exports, "."));
              const rootTarget =
                rootEntry === undefined
                  ? undefined
                  : sourceModuleTarget(resolve(pkg.dir, rootEntry));
              if (target === rootTarget && file !== rootTarget) {
                errors.push(
                  `${sourceEdge.file}:${edge.line}: source imports its own public entrypoint ${pkg.name}`,
                );
              }
            }
          }
        }
      }
    }
  }

  for (const pkg of packages) {
    const used = new Set(
      pkg.sourceEdges
        .map((edge) => workspacePackageName(edge.specifier))
        .filter((name) => name && name !== pkg.name),
    );
    for (const declared of pkg.declared) {
      if (!byName.has(declared)) {
        errors.push(`${pkg.name}: declares unknown workspace dependency ${declared}`);
        continue;
      }
      const violation = enforceArchitecture
        ? packageDependencyViolation(pkg.name, declared)
        : undefined;
      if (violation !== undefined) errors.push(`${pkg.name}: ${violation}`);
      if (used.has(declared)) continue;
      errors.push(`${pkg.name}: declares unused internal dependency ${declared}`);
    }
    const references = referenceNames(pkg, byDir);
    if (references !== null) {
      for (const dep of pkg.runtimeDeclared)
        if (!references.has(dep))
          errors.push(`${pkg.name}: dependency without project reference ${dep}`);
      for (const ref of references)
        if (!pkg.runtimeDeclared.has(ref))
          errors.push(`${pkg.name}: project reference without runtime dependency ${ref}`);
    }
  }

  const rootConfigFile = join(repoRoot, "tsconfig.json");
  if (existsSync(rootConfigFile)) {
    const rootConfig = readJsonc(rootConfigFile);
    const rootReferences = new Set<string>(
      (rootConfig.references ?? []).map(({ path }) => {
        const resolved = resolve(repoRoot, path);
        const target = extname(resolved) === ".json" ? dirname(resolved) : resolved;
        return byDir.get(target)?.name ?? `?${posix(relative(repoRoot, target))}`;
      }),
    );
    const buildPackages = new Set<string>(
      packages
        .filter((pkg) => existsSync(join(pkg.dir, "tsconfig.build.json")))
        .map((pkg) => pkg.name),
    );
    for (const pkg of buildPackages) {
      if (!rootReferences.has(pkg)) errors.push(`root tsconfig missing project reference ${pkg}`);
    }
    for (const ref of rootReferences) {
      if (!buildPackages.has(ref))
        errors.push(`root tsconfig has unknown project reference ${ref}`);
    }
  }

  const declaredGraph = new Map(
    packages.map((pkg) => [
      pkg.name,
      new Set([...pkg.runtimeDeclared].filter((name) => byName.has(name))),
    ]),
  );
  const cycles = stronglyConnectedComponents(
    packages.map((pkg) => pkg.name),
    declaredGraph,
  );
  for (const cycle of cycles) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);

  const compilationGraph = adjacencyFrom(packages, () => true);
  const eagerGraph = adjacencyFrom(
    packages,
    (edge) => edge.sourceTree === "src" && edge.kind === "static" && !edge.typeOnly,
  );
  const dynamicGraph = adjacencyFrom(
    packages,
    (edge) => edge.sourceTree === "src" && edge.kind === "dynamic",
  );
  const compilationCycles = stronglyConnectedComponents(
    packages.map((pkg) => pkg.name),
    compilationGraph,
  );
  for (const cycle of compilationCycles) {
    if (!cycles.some((declared) => declared.join("\0") === cycle.join("\0"))) {
      errors.push(`compilation cycle: ${cycle.join(" -> ")}`);
    }
  }

  const moduleCycles = [];
  for (const pkg of packages) {
    const files = walk(join(pkg.dir, "src"));
    const adjacency = new Map(files.map((file) => [file, new Set()]));
    for (const edge of pkg.moduleEdges) adjacency.get(edge.from)?.add(edge.to);
    for (const cycle of stronglyConnectedComponents(files, adjacency)) {
      const rendered = cycle.map((file) => posix(relative(pkg.dir, file)));
      moduleCycles.push({ package: pkg.name, files: rendered });
      errors.push(`${pkg.name}: runtime module cycle: ${rendered.join(" -> ")}`);
    }
  }

  const consumers = new Map(packages.map((pkg) => [pkg.name, 0]));
  for (const deps of declaredGraph.values())
    for (const dep of deps) consumers.set(dep, consumers.get(dep) + 1);
  const reportPackages = packages.map((pkg) => {
    const staticRuntime = new Set();
    const dynamicRuntime = new Set();
    const typeOnly = new Set();
    for (const edge of pkg.sourceEdges) {
      const name = workspacePackageName(edge.specifier);
      if (name === undefined || name === pkg.name || !byName.has(name)) continue;
      if (edge.sourceTree !== "src") continue;
      if (edge.typeOnly) typeOnly.add(name);
      else if (edge.kind === "dynamic") dynamicRuntime.add(name);
      else staticRuntime.add(name);
    }
    return {
      name: pkg.name,
      role: packageRoleOf(pkg.name) ?? "unclassified",
      directory: pkg.relDir,
      dependencies: [...(declaredGraph.get(pkg.name) ?? [])].sort(),
      optionalDependencies: [...pkg.declaredByField.optionalDependencies].sort(),
      consumers: consumers.get(pkg.name) ?? 0,
      sourceEdges: {
        compilation: [...(compilationGraph.get(pkg.name) ?? [])].sort(),
        eagerRuntime: [...staticRuntime].sort(),
        dynamicRuntime: [...dynamicRuntime].sort(),
        typeOnly: [...typeOnly].sort(),
      },
      runtimeClosure: {
        eager: reachableFrom(pkg.name, eagerGraph),
        dynamic: dynamicReachableFrom(pkg.name, eagerGraph, dynamicGraph),
      },
    };
  });
  return {
    packageCount: packages.length,
    edgeCount: [...declaredGraph.values()].reduce((sum, deps) => sum + deps.size, 0),
    optionalEdgeCount: packages.reduce(
      (sum, pkg) => sum + pkg.declaredByField.optionalDependencies.size,
      0,
    ),
    packages: reportPackages,
    cycles,
    compilationCycles,
    moduleCycles,
    errors: [...new Set(errors)].sort(),
  };
}

/** Render the checked role table and direct graph committed in the coupling spec. */
export function renderMarkdown(report) {
  const shortName = (name) => name.replace("@clarvis/", "");
  const rows = report.packages.map((pkg) => {
    const dependencies = pkg.dependencies
      .map((dependency) => {
        const optional = pkg.optionalDependencies.includes(dependency) ? " (optional)" : "";
        return `\`${shortName(dependency)}\`${optional}`;
      })
      .join(", ");
    return `| \`${shortName(pkg.name)}\` | ${pkg.role} | ${dependencies || "—"} | ${pkg.consumers} |`;
  });
  const ids = new Map<string, string>(
    report.packages.map((pkg): [string, string] => [
      pkg.name,
      shortName(pkg.name).replace(/[^a-z0-9]+/g, "_"),
    ]),
  );
  const idOf = (name: string): string => ids.get(name) ?? shortName(name);
  const graph = ["flowchart LR"];
  for (const role of PACKAGE_ROLE_ORDER) {
    const members = report.packages.filter((pkg) => pkg.role === role);
    if (members.length === 0) continue;
    graph.push(`  subgraph role_${role.replace(/-/g, "_")}["${packageRoleLabel(role)}"]`);
    for (const pkg of members) graph.push(`    ${idOf(pkg.name)}["${pkg.name}"]`);
    graph.push("  end");
  }
  for (const pkg of report.packages) {
    for (const dependency of pkg.dependencies) {
      const edge = pkg.optionalDependencies.includes(dependency) ? "-. optional .->" : "-->";
      graph.push(`  ${idOf(pkg.name)} ${edge} ${idOf(dependency)}`);
    }
  }
  return [
    `Packages: ${report.packageCount}; internal edges: ${report.edgeCount}; optional edges: ${report.optionalEdgeCount}.`,
    "",
    "| Package | Role | Direct internal dependencies | Internal consumers |",
    "| --- | --- | --- | ---: |",
    ...rows,
    "",
    "### Direct graph grouped by role",
    "",
    "Arrows point from consumer to dependency; a dotted arrow is optional.",
    "",
    "```mermaid",
    ...graph,
    "```",
  ].join("\n");
}

const GENERATED_START = "<!-- package-graph:start -->";
const GENERATED_END = "<!-- package-graph:end -->";

/** Validate the complete generated fragment committed in the coupling spec. */
export function checkDocument(report, document) {
  const start = document.indexOf(GENERATED_START);
  const end = document.indexOf(GENERATED_END);
  if (start < 0 || end < 0 || end <= start)
    return ["package graph document is missing its generated block markers"];
  const actual = document.slice(start + GENERATED_START.length, end).trim();
  return actual === renderMarkdown(report)
    ? []
    : ["package graph document's generated block is stale; regenerate it from renderMarkdown"];
}
