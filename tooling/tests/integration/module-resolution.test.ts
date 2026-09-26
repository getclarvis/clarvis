import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dir, "../../..");

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

test("workspace exports select source in development and declarations in build", () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-module-resolution-"));
  try {
    const provider = join(root, "packages", "provider");
    const consumer = join(root, "packages", "consumer");
    for (const dir of [provider, consumer]) mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "@fixture"), { recursive: true });
    symlinkSync(provider, join(root, "node_modules", "@fixture", "provider"), "dir");
    symlinkSync(consumer, join(root, "node_modules", "@fixture", "consumer"), "dir");
    writeJson(join(provider, "package.json"), {
      name: "@fixture/provider",
      type: "module",
      exports: {
        ".": { bun: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
    });
    writeJson(join(consumer, "package.json"), {
      name: "@fixture/consumer",
      type: "module",
      dependencies: { "@fixture/provider": "workspace:*" },
      exports: {
        ".": { bun: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
    });
    writeFileSync(
      join(provider, "src", "index.ts"),
      'export const marker = "provider-source";\nexport type Marker = typeof marker;\n',
    );
    writeFileSync(join(consumer, "src", "local.ts"), 'export const local = "relative-output";\n');
    writeFileSync(
      join(consumer, "src", "index.ts"),
      'import { marker } from "@fixture/provider";\nimport { local } from "./local.ts";\nexport type { Marker } from "@fixture/provider";\nexport const value = `${marker}:${local}`;\n',
    );
    const development = {
      compilerOptions: {
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        rewriteRelativeImportExtensions: true,
        strict: true,
        noEmit: true,
        customConditions: ["bun"],
        skipLibCheck: true,
      },
      include: ["src"],
    };
    for (const dir of [provider, consumer]) {
      writeJson(join(dir, "tsconfig.json"), development);
      writeJson(join(dir, "tsconfig.build.json"), {
        extends: "./tsconfig.json",
        compilerOptions: {
          composite: true,
          noEmit: false,
          customConditions: [],
          declaration: true,
          rootDir: "src",
          outDir: "dist",
          tsBuildInfoFile: "dist/.tsbuildinfo",
        },
        references: dir === consumer ? [{ path: "../provider/tsconfig.build.json" }] : [],
      });
    }
    writeJson(join(root, "tsconfig.json"), {
      files: [],
      references: [
        { path: "packages/provider/tsconfig.build.json" },
        { path: "packages/consumer/tsconfig.build.json" },
      ],
    });
    const consumerSource = join(consumer, "src", "index.ts");
    const developmentConfig = ts.getParsedCommandLineOfConfigFile(
      join(consumer, "tsconfig.json"),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
        },
      },
    );
    expect(developmentConfig).toBeDefined();
    expect(
      ts.resolveModuleName("@fixture/provider", consumerSource, developmentConfig.options, ts.sys)
        .resolvedModule?.resolvedFileName,
    ).toBe(join(provider, "src", "index.ts"));

    const compiler = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
    const build = spawnSync(process.execPath, [compiler, "-b", "tsconfig.json"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);
    const buildConfig = ts.getParsedCommandLineOfConfigFile(
      join(consumer, "tsconfig.build.json"),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
        },
      },
    );
    expect(buildConfig?.options.customConditions).toEqual([]);
    expect(
      ts.resolveModuleName("@fixture/provider", consumerSource, buildConfig.options, ts.sys)
        .resolvedModule?.resolvedFileName,
    ).toBe(join(provider, "dist", "index.d.ts"));
    const emitted = readFileSync(join(consumer, "dist", "index.js"), "utf8");
    expect(emitted).toContain('from "@fixture/provider"');
    expect(emitted).toContain('from "./local.js"');
    expect(readFileSync(join(consumer, "dist", "index.d.ts"), "utf8")).toContain(
      "@fixture/provider",
    );
    const runtime = spawnSync(
      process.execPath,
      ["-e", 'import { value } from "@fixture/consumer"; console.log(value)'],
      { cwd: root, encoding: "utf8" },
    );
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(runtime.stdout.trim()).toBe("provider-source:relative-output");
    const emittedRuntime = spawnSync(
      process.execPath,
      ["-e", 'import { value } from "./packages/consumer/dist/index.js"; console.log(value)'],
      { cwd: root, encoding: "utf8" },
    );
    expect(emittedRuntime.status, emittedRuntime.stderr).toBe(0);
    expect(emittedRuntime.stdout.trim()).toBe("provider-source:relative-output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
