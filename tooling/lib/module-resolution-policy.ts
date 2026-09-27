import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

interface WorkspaceSurface {
  name: string;
  dir: string;
  manifest: { exports?: Record<string, unknown> | string; imports?: Record<string, unknown> };
  sourceEdges?: readonly { file: string; specifier: string }[];
}

interface ConfigAccess {
  fileExists(path: string): boolean;
  readFile(path: string): string | undefined;
  readDirectory: typeof ts.sys.readDirectory;
  getCurrentDirectory(): string;
  directoryExists(path: string): boolean;
  realpath(path: string): string;
}

const diskAccess: ConfigAccess = {
  fileExists: existsSync,
  readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  readDirectory: (...args) => ts.sys.readDirectory(...args),
  getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
  directoryExists: (path) => ts.sys.directoryExists(path),
  realpath: (path) => realpathSync(path),
};

const PRIVATE_SOURCE = /^#src\/(.+)\.(ts|tsx)$/;

function pathIdentity(path: string, access: ConfigAccess): string {
  return access.fileExists(path) ? access.realpath(path) : resolve(path);
}

/** Resolve a package-owned private source import and reject mappings outside its src tree. */
export function privateImportTarget(
  root: string,
  pkg: WorkspaceSurface,
  importer: string,
  specifier: string,
  access: ConfigAccess = diskAccess,
): { target?: string; errors: string[] } {
  if (!specifier.startsWith("#src/")) return { errors: [] };
  const manifest = join(pkg.dir, "package.json");
  const label = `${displayed(root, manifest)}: ${displayed(root, importer)}: ${specifier}`;
  const match = PRIVATE_SOURCE.exec(specifier);
  if (!match || match[1].split("/").some((part) => part === "." || part === ".." || part === ""))
    return { errors: [`${label}: expected #src/path/module.ts or .tsx inside this package`] };
  const imports = pkg.manifest.imports;
  const library = imports?.["#src/*.ts"];
  const application = imports?.["#src/*"];
  const mapping = library ?? application;
  if (mapping === undefined)
    return { errors: [`${label}: package must declare its own #src/ mapping`] };
  const errors: string[] = [];
  const expectedSource = resolve(pkg.dir, "src", `${match[1]}.${match[2]}`);
  const realPackage = access.realpath(pkg.dir);
  const realImporter = pathIdentity(importer, access);
  if (!realImporter.startsWith(realPackage + sep))
    errors.push(`${label}: importer is outside the owning package`);
  if (library !== undefined) {
    const conditions =
      library !== null && typeof library === "object" && !Array.isArray(library)
        ? (library as Record<string, unknown>)
        : {};
    if (
      match[2] !== "ts" ||
      Object.keys(conditions).join(",") !== "bun,types,default" ||
      conditions.bun !== "./src/*.ts" ||
      conditions.types !== "./dist/*.d.ts" ||
      conditions.default !== "./dist/*.js" ||
      application !== undefined
    )
      errors.push(
        `${label}: library mapping must be #src/*.ts with ordered bun, types, default source and output targets`,
      );
  } else if (
    application !== "./src/*" ||
    Object.keys(imports ?? {}).filter((key) => key.startsWith("#src/")).length !== 1
  ) {
    errors.push(`${label}: application mapping must be #src/* -> ./src/*`);
  }
  if (errors.length > 0) return { errors };
  if (!access.fileExists(expectedSource))
    return { errors: [`${label}: source does not exist: ${displayed(root, expectedSource)}`] };
  const realSource = pathIdentity(expectedSource, access);
  const realSrc = access.realpath(join(pkg.dir, "src"));
  if (!realSource.startsWith(realSrc + sep))
    return { errors: [`${label}: source escapes package src: ${displayed(root, expectedSource)}`] };
  const configFile = join(pkg.dir, "tsconfig.json");
  const config = access.fileExists(configFile)
    ? ts.getParsedCommandLineOfConfigFile(
        configFile,
        {},
        {
          ...access,
          useCaseSensitiveFileNames: true,
          onUnRecoverableConfigFileDiagnostic: () => {},
        },
      )
    : undefined;
  const resolved = ts.resolveModuleName(
    specifier,
    importer,
    config?.options ?? {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      customConditions: ["bun"],
    },
    access,
  ).resolvedModule?.resolvedFileName;
  if (resolved === undefined || pathIdentity(resolved, access) !== realSource)
    return { errors: [`${label}: TypeScript must resolve to ${displayed(root, expectedSource)}`] };
  return { target: expectedSource, errors: [] };
}

function privateMappingErrors(root: string, pkg: WorkspaceSurface, access: ConfigAccess): string[] {
  const imports = pkg.manifest.imports;
  if (imports === undefined) return [];
  const label = displayed(root, join(pkg.dir, "package.json"));
  const entries = Object.entries(imports).filter(([key]) => key.startsWith("#src/"));
  if (entries.length === 0) return [];
  if (entries.length !== 1) return [`${label}: declare exactly one #src/ mapping`];
  const [key, value] = entries[0];
  if (
    key === "#src/*" &&
    value === "./src/*" &&
    !access.fileExists(join(pkg.dir, "tsconfig.build.json"))
  )
    return [];
  if (
    key === "#src/*.ts" &&
    access.fileExists(join(pkg.dir, "tsconfig.build.json")) &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const conditions = value as Record<string, unknown>;
    if (
      Object.keys(conditions).join(",") === "bun,types,default" &&
      conditions.bun === "./src/*.ts" &&
      conditions.types === "./dist/*.d.ts" &&
      conditions.default === "./dist/*.js"
    )
      return [];
  }
  return [
    `${label}: invalid #src/ mapping; expected application source or ordered library bun, types, default targets`,
  ];
}

function displayed(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function readOwnConfig(file: string, access: ConfigAccess): Record<string, unknown> | undefined {
  const source = access.readFile(file);
  if (source === undefined) return undefined;
  const parsed = ts.parseConfigFileTextToJson(file, source);
  return parsed.error === undefined ? parsed.config : undefined;
}

function configOrigin(
  file: string,
  access: ConfigAccess,
  seen = new Set<string>(),
): string | undefined {
  if (seen.has(file)) return undefined;
  seen.add(file);
  const config = readOwnConfig(file, access);
  if (config === undefined) return undefined;
  if ((config.compilerOptions as { paths?: unknown } | undefined)?.paths !== undefined) return file;
  const inherited = config.extends;
  const entries = Array.isArray(inherited)
    ? inherited
    : typeof inherited === "string"
      ? [inherited]
      : [];
  for (const entry of entries.toReversed()) {
    if (typeof entry !== "string" || !entry.startsWith(".")) continue;
    const parent = resolve(dirname(file), entry.endsWith(".json") ? entry : `${entry}.json`);
    if (!access.fileExists(parent)) continue;
    const origin = configOrigin(parent, access, seen);
    if (origin !== undefined) return origin;
  }
  return undefined;
}

function publicExport(manifest: WorkspaceSurface["manifest"], subpath: string): unknown {
  const exports = manifest.exports;
  if (typeof exports === "string") return subpath === "." ? exports : undefined;
  if (exports === undefined) return undefined;
  if (exports[subpath] !== undefined) return exports[subpath];
  for (const [pattern, target] of Object.entries(exports)) {
    const star = pattern.indexOf("*");
    if (
      star < 0 ||
      subpath.length < pattern.length - 1 ||
      !subpath.startsWith(pattern.slice(0, star)) ||
      !subpath.endsWith(pattern.slice(star + 1))
    )
      continue;
    const captured = subpath.slice(star, subpath.length - (pattern.length - star - 1));
    if (typeof target === "string") return target.replace("*", captured);
    if (target !== null && typeof target === "object" && !Array.isArray(target)) {
      return Object.fromEntries(
        Object.entries(target).map(([condition, value]) => [
          condition,
          typeof value === "string" ? value.replace("*", captured) : value,
        ]),
      );
    }
    return target;
  }
  return subpath === "." && !Object.keys(exports).some((key) => key.startsWith("."))
    ? exports
    : undefined;
}

function emittedTarget(source: string, declaration: boolean): string {
  return source.replace(/^\.\/src\//, "./dist/").replace(/\.(?:ts|tsx|mts|cts)$/, (extension) => {
    if (extension === ".mts") return declaration ? ".d.mts" : ".mjs";
    if (extension === ".cts") return declaration ? ".d.cts" : ".cjs";
    return declaration ? ".d.ts" : ".js";
  });
}

function publicTargetErrors(
  root: string,
  pkg: WorkspaceSurface,
  subpath: string,
  access: ConfigAccess,
): string[] {
  const specifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
  const target = publicExport(pkg.manifest, subpath);
  if (target === undefined) return [`${specifier}: no public export`];
  if (target === null || typeof target !== "object" || Array.isArray(target)) return [];
  const conditions = target as Record<string, unknown>;
  if (typeof conditions.bun !== "string" || typeof conditions.types !== "string") {
    return [`${specifier}: public export requires bun source and types declaration`];
  }
  const errors: string[] = [];
  if (Object.keys(conditions).indexOf("bun") > Object.keys(conditions).indexOf("types")) {
    errors.push(`${specifier}: bun must precede types in exports`);
  }
  const source = resolve(pkg.dir, conditions.bun);
  if (!access.fileExists(source))
    errors.push(`${specifier}: bun source does not exist: ${displayed(root, source)}`);
  if (
    !/\.(?:ts|tsx|mts|cts)$/.test(conditions.bun) ||
    conditions.types !== emittedTarget(conditions.bun, true)
  ) {
    errors.push(`${specifier}: types target does not match bun source`);
  }
  if (
    typeof conditions.import === "string" &&
    conditions.import !== emittedTarget(conditions.bun, false)
  ) {
    errors.push(`${specifier}: import target does not match emitted JavaScript`);
  }
  return errors;
}

/** Enforce export based source resolution and isolated declaration builds. */
export function moduleResolutionPolicyErrors(
  root: string,
  packages: readonly WorkspaceSurface[],
  access: ConfigAccess = diskAccess,
): string[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const errors: string[] = [];
  for (const pkg of packages) {
    errors.push(...privateMappingErrors(root, pkg, access));
    for (const edge of pkg.sourceEdges ?? []) {
      if (!edge.specifier.startsWith("#src/")) continue;
      const importer = resolve(root, edge.file);
      errors.push(...privateImportTarget(root, pkg, importer, edge.specifier, access).errors);
    }
  }
  const configs: Array<{
    consumer?: WorkspaceSurface;
    profile: "development" | "build" | "tooling";
    file: string;
  }> = packages.flatMap((pkg) => [
    { consumer: pkg, profile: "development", file: join(pkg.dir, "tsconfig.json") },
    { consumer: pkg, profile: "build", file: join(pkg.dir, "tsconfig.build.json") },
  ]);
  configs.push({ profile: "development", file: join(root, "tooling", "tsconfig.json") });
  configs.push({ profile: "tooling", file: join(root, "tooling", "tsconfig.check.json") });
  for (const { consumer, profile, file } of configs) {
    if (!access.fileExists(file)) continue;
    const diagnostics: ts.Diagnostic[] = [];
    const parsed = ts.getParsedCommandLineOfConfigFile(
      file,
      {},
      {
        ...access,
        useCaseSensitiveFileNames: true,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    );
    const label = displayed(root, file);
    if (parsed === undefined) {
      errors.push(`${label}: TypeScript configuration could not be parsed`);
      continue;
    }
    diagnostics.push(...parsed.errors);
    for (const diagnostic of diagnostics)
      errors.push(`${label}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    const options = parsed.options;
    if (profile === "development") {
      if (options.noEmit !== true) errors.push(`${label}: development must set noEmit true`);
      if (!options.customConditions?.includes("bun"))
        errors.push(`${label}: development must enable bun condition`);
    } else if (profile === "tooling") {
      if (options.noEmit !== true || options.customConditions?.includes("bun")) {
        errors.push(`${label}: tooling CLI must typecheck declarations without emitting`);
      }
    } else if (consumer !== undefined) {
      if (options.noEmit !== false) errors.push(`${label}: build must set noEmit false`);
      if (options.customConditions?.includes("bun"))
        errors.push(`${label}: build must disable bun condition`);
      if (options.composite !== true || options.declaration !== true)
        errors.push(`${label}: build must emit composite declarations`);
      if (
        options.rootDir !== join(consumer.dir, "src") ||
        options.outDir !== join(consumer.dir, "dist")
      ) {
        errors.push(`${label}: build output must be confined to package src and dist`);
      }
    }
    if (options.paths !== undefined) {
      const origin = configOrigin(file, access) ?? file;
      for (const specifier of Object.keys(options.paths)) {
        if (specifier.startsWith("@clarvis/") || specifier.startsWith("#src/"))
          errors.push(
            `${displayed(root, origin)} (${profile} ${specifier}): ${specifier.startsWith("#src/") ? "private" : "workspace"} paths alias is forbidden`,
          );
      }
    }
    if (profile !== "development" || consumer === undefined) continue;
    for (const edge of consumer.sourceEdges ?? []) {
      if (!edge.specifier.startsWith("@clarvis/")) continue;
      const name = edge.specifier.split("/").slice(0, 2).join("/");
      const provider = byName.get(name);
      if (provider === undefined) continue;
      const subpath = edge.specifier === name ? "." : `.${edge.specifier.slice(name.length)}`;
      errors.push(...publicTargetErrors(root, provider, subpath, access));
      const target = publicExport(provider.manifest, subpath);
      const source =
        target !== null && typeof target === "object" && !Array.isArray(target)
          ? (target as Record<string, unknown>).bun
          : undefined;
      if (typeof source !== "string") continue;
      const resolved = ts.resolveModuleName(
        edge.specifier,
        resolve(root, edge.file),
        options,
        access,
      ).resolvedModule?.resolvedFileName;
      const expected = resolve(provider.dir, source);
      const identity = (path: string) => (access.fileExists(path) ? access.realpath(path) : path);
      if (resolved === undefined || identity(resolved) !== identity(expected)) {
        errors.push(
          `${edge.file}: ${edge.specifier} does not resolve to bun source ${displayed(root, expected)}`,
        );
      }
    }
  }
  return [...new Set(errors)].sort();
}
