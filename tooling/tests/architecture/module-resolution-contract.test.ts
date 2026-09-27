import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import ts from "typescript";
import { parseModuleEdges } from "../../lib/package-graph.ts";

const root = resolve(import.meta.dir, "../../..");

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? files(path)
      : /\.(?:ts|tsx|mts|cts)$/.test(name)
        ? [path]
        : [];
  });
}

test("workspace imports resolve through bun exports with dist hidden", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces: string[];
  };
  const packages = manifest.workspaces.map((workspace) => {
    const dir = resolve(root, workspace);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name: string;
      exports?: Record<string, { bun?: string }>;
      imports?: Record<string, unknown>;
    };
    return { ...pkg, dir };
  });
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const hidden = (path: string) =>
    path.split(sep).includes("dist") &&
    (path.startsWith(join(root, "packages") + sep) ||
      path.includes(`${sep}node_modules${sep}@clarvis${sep}`));
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => !hidden(path) && existsSync(path),
    readFile: (path) =>
      hidden(path) ? undefined : existsSync(path) ? readFileSync(path, "utf8") : undefined,
    directoryExists: (path) => !hidden(path) && ts.sys.directoryExists(path),
    realpath: (path) => realpathSync(path),
  };
  let checked = 0;
  let privateChecked = 0;
  let hiddenQueries = 0;
  for (const pkg of packages) {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(pkg.dir, "tsconfig.json"),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
        },
      },
    );
    expect(parsed).toBeDefined();
    const seen = new Set<string>();
    for (const tree of ["src", "tests", "tooling"]) {
      for (const file of files(join(pkg.dir, tree))) {
        for (const edge of parseModuleEdges(readFileSync(file, "utf8"), file)) {
          if (edge.specifier.startsWith("#src/")) {
            if (pkg.name === "@clarvis/code") {
              expect(pkg.imports?.["#src/*"]).toBe("./src/*");
            } else {
              expect(pkg.imports?.["#src/*.ts"]).toEqual({
                bun: "./src/*.ts",
                types: "./dist/*.d.ts",
                default: "./dist/*.js",
              });
            }
            const actual = ts.resolveModuleName(edge.specifier, file, parsed.options, host)
              .resolvedModule?.resolvedFileName;
            expect(actual).toBeDefined();
            expect(realpathSync(actual)).toBe(
              realpathSync(resolve(pkg.dir, "src", edge.specifier.slice("#src/".length))),
            );
            privateChecked++;
            continue;
          }
          if (!edge.specifier.startsWith("@clarvis/") || seen.has(edge.specifier)) continue;
          seen.add(edge.specifier);
          const name = edge.specifier.split("/").slice(0, 2).join("/");
          const provider = byName.get(name);
          expect(provider).toBeDefined();
          const subpath = edge.specifier === name ? "." : `.${edge.specifier.slice(name.length)}`;
          const source = provider?.exports?.[subpath]?.bun;
          expect(source).toBeDefined();
          const result = ts.resolveModuleName(edge.specifier, file, parsed.options, {
            ...host,
            fileExists: (path) => {
              if (hidden(path)) hiddenQueries++;
              return host.fileExists(path);
            },
          });
          const actual = result.resolvedModule?.resolvedFileName;
          expect(actual).toBeDefined();
          expect(realpathSync(actual)).toBe(realpathSync(resolve(provider.dir, source)));
          checked++;
        }
      }
    }
  }
  const toolingConfig = ts.getParsedCommandLineOfConfigFile(
    join(root, "tooling", "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
      },
    },
  );
  expect(toolingConfig?.options.customConditions).toContain("bun");
  const toolingSpecifiers = new Set<string>();
  for (const file of files(join(root, "tooling"))) {
    for (const edge of parseModuleEdges(readFileSync(file, "utf8"), file)) {
      if (!edge.specifier.startsWith("@clarvis/") || toolingSpecifiers.has(edge.specifier))
        continue;
      toolingSpecifiers.add(edge.specifier);
      const name = edge.specifier.split("/").slice(0, 2).join("/");
      const provider = byName.get(name);
      const subpath = edge.specifier === name ? "." : `.${edge.specifier.slice(name.length)}`;
      const source = provider?.exports?.[subpath]?.bun;
      expect(source).toBeDefined();
      const actual = ts.resolveModuleName(edge.specifier, file, toolingConfig.options, host)
        .resolvedModule?.resolvedFileName;
      expect(actual).toBeDefined();
      expect(realpathSync(actual)).toBe(realpathSync(resolve(provider.dir, source)));
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(40);
  expect(privateChecked).toBeGreaterThan(0);
  expect(hiddenQueries).toBe(0);
});
