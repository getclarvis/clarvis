#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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

/** Report runtime-style relative specifiers that alias a TypeScript source file. */
export function aliasedTypeScriptImports(file, source, fileExists = existsSync) {
  const failures = [];
  for (const specifier of moduleSpecifiers(file, source)) {
    if (!specifier.startsWith(".")) continue;
    const runtimeExtension = [...RUNTIME_TO_SOURCE_EXTENSIONS.keys()].find((extension) =>
      specifier.endsWith(extension),
    );
    if (runtimeExtension == null) continue;

    const runtimePath = resolve(dirname(file), specifier);
    if (fileExists(runtimePath)) continue;
    const sourceStem = runtimePath.slice(0, -runtimeExtension.length);
    const sourcePath = RUNTIME_TO_SOURCE_EXTENSIONS.get(runtimeExtension)
      .map((extension) => `${sourceStem}${extension}`)
      .find(fileExists);
    if (sourcePath != null) {
      const expectedPath = relative(dirname(file), sourcePath).replaceAll("\\", "/");
      failures.push({
        file,
        specifier,
        expected: expectedPath.startsWith(".") ? expectedPath : `./${expectedPath}`,
      });
    }
  }
  return failures;
}

/** Return tracked and unignored TypeScript source paths. */
export function typescriptSourcePaths(paths) {
  return paths.filter((path) => SOURCE_EXTENSION.test(path)).sort();
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../..");
  const failures = typescriptSourcePaths(repositoryPaths(root)).flatMap((path) => {
    const file = resolve(root, path);
    return aliasedTypeScriptImports(file, readFileSync(file, "utf8")).map((failure) => ({
      ...failure,
      file: path,
    }));
  });

  if (failures.length > 0) {
    console.error(
      `relative import extensions (${String(failures.length)}):\n${failures
        .map(({ file, specifier, expected }) => `- ${file}: ${specifier} -> ${expected}`)
        .join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      "import extensions: every relative TypeScript source import names its real extension",
    );
  }
}
