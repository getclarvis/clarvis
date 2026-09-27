#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { repositoryPaths } from "./bun-sources.ts";

const SOURCE_EXTENSION = /\.(?:cts|mts|ts|tsx)$/;
const RUNTIME_TO_SOURCE_EXTENSIONS = new Map([
  [".cjs", [".cts"]],
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
]);

function literalModuleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier != null &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression != null &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    return node.arguments[0].text;
  }
  return undefined;
}

/** Collect literal module specifiers without matching examples inside comments or strings. */
export function moduleSpecifiers(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const specifiers = [];
  const visit = (node) => {
    const specifier = literalModuleSpecifier(node);
    if (specifier != null) specifiers.push(specifier);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function relativeSpecifier(file, target) {
  const path = relative(dirname(file), target).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

/** Report relative imports without an extension or with a JavaScript alias for TypeScript. */
export function invalidRelativeImportExtensions(file, source, fileExists = existsSync) {
  const failures = [];
  for (const specifier of moduleSpecifiers(file, source)) {
    if (!specifier.startsWith(".")) continue;
    const target = resolve(dirname(file), specifier);
    if (extname(specifier) === "") {
      const candidates = [".ts", ".tsx", ".mts", ".cts"]
        .map((extension) => `${target}${extension}`)
        .concat(
          [".ts", ".tsx", ".mts", ".cts"].map((extension) => resolve(target, `index${extension}`)),
        )
        .filter(fileExists);
      failures.push({
        file,
        specifier,
        expected: candidates.length === 1 ? relativeSpecifier(file, candidates[0]) : undefined,
      });
      continue;
    }
    const runtimeExtension = [...RUNTIME_TO_SOURCE_EXTENSIONS.keys()].find((extension) =>
      specifier.endsWith(extension),
    );
    if (runtimeExtension == null) continue;

    const runtimePath = target;
    if (fileExists(runtimePath)) continue;
    const sourceStem = runtimePath.slice(0, -runtimeExtension.length);
    const sourcePath = RUNTIME_TO_SOURCE_EXTENSIONS.get(runtimeExtension)
      .map((extension) => `${sourceStem}${extension}`)
      .find(fileExists);
    if (sourcePath != null) {
      failures.push({
        file,
        specifier,
        expected: relativeSpecifier(file, sourcePath),
      });
    }
  }
  return failures;
}

/** Require private aliases for long same-package source edges, including unmapped packages. */
export function invalidPrivateImportConvention(
  pkgDir,
  file,
  source,
  fileExists = existsSync,
  imports = undefined,
) {
  const manifestFile = join(pkgDir, "package.json");
  const mappings =
    imports ??
    (fileExists(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")).imports : {});
  const mapped = mappings?.["#src/*"] !== undefined || mappings?.["#src/*.ts"] !== undefined;
  const sourceRoot = join(pkgDir, "src");
  const importerInSource = file.startsWith(sourceRoot + sep);
  const fromTestsOrTooling = ["tests", "tooling"].some((tree) =>
    file.startsWith(join(pkgDir, tree) + sep),
  );
  if (!importerInSource && !fromTestsOrTooling) return [];
  return moduleSpecifiers(file, source).flatMap((specifier) => {
    if (!specifier.startsWith(".")) return [];
    const target = resolve(dirname(file), specifier);
    if (
      !fileExists(target) ||
      !/\.(?:ts|tsx)$/.test(target) ||
      !target.startsWith(sourceRoot + sep)
    )
      return [];
    const upwards = relative(dirname(file), target)
      .split(sep)
      .filter((part) => part === "..").length;
    if (importerInSource && upwards < 2) return [];
    const expected = `#src/${relative(sourceRoot, target).split(sep).join("/")}`;
    return [{ file, specifier, expected, target, manifest: manifestFile, needsMapping: !mapped }];
  });
}

/** Return tracked and unignored TypeScript source paths. */
export function typescriptSourcePaths(paths) {
  return paths.filter((path) => SOURCE_EXTENSION.test(path)).sort();
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../..");
  const failures = typescriptSourcePaths(repositoryPaths(root)).flatMap((path) => {
    const file = resolve(root, path);
    const source = readFileSync(file, "utf8");
    const packageName = /^packages\/([^/]+)\//.exec(path)?.[1];
    const pkgDir = packageName === undefined ? undefined : join(root, "packages", packageName);
    const violations = [
      ...invalidRelativeImportExtensions(file, source),
      ...(pkgDir === undefined ? [] : invalidPrivateImportConvention(pkgDir, file, source)),
    ];
    return violations.map((failure) => ({
      ...failure,
      file: path,
    }));
  });

  if (failures.length > 0) {
    console.error(
      `import conventions (${String(failures.length)}):\n${failures
        .map(
          ({ file, specifier, expected, target, manifest, needsMapping }) =>
            `- ${file}: ${specifier}${expected === undefined ? " (missing extension)" : ` -> ${expected}`}${target === undefined ? "" : ` (target ${relative(root, target)}${needsMapping ? `; declare a compatible #src/ mapping in ${relative(root, manifest)}` : ""})`}`,
        )
        .join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      "import conventions: literal relatives use source extensions and long same-package imports use private source aliases",
    );
  }
}
