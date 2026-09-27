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
      imports: {
        "#src/*.ts": { bun: "./src/*.ts", types: "./dist/*.d.ts", default: "./dist/*.js" },
      },
    });
    writeJson(join(consumer, "package.json"), {
      name: "@fixture/consumer",
      type: "module",
      dependencies: { "@fixture/provider": "workspace:*" },
      exports: {
        ".": { bun: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
      imports: {
        "#src/*.ts": { bun: "./src/*.ts", types: "./dist/*.d.ts", default: "./dist/*.js" },
      },
    });
    writeFileSync(
      join(provider, "src", "index.ts"),
      'export { marker } from "#src/marker.ts";\nexport type { Marker } from "#src/type.ts";\n',
    );
    writeFileSync(join(provider, "src", "marker.ts"), 'export const marker = "provider-source";\n');
    writeFileSync(join(provider, "src", "type.ts"), 'export type Marker = "provider-source";\n');
    writeFileSync(
      join(consumer, "src", "local.ts"),
      'export const local = "relative-output";\nexport type Local = typeof local;\n',
    );
    writeFileSync(
      join(consumer, "src", "index.ts"),
      'import { marker } from "@fixture/provider";\nimport { local } from "#src/local.ts";\nexport type { Marker } from "@fixture/provider";\nexport type { Local } from "#src/local.ts";\nexport const value = `${marker}:${local}`;\n',
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
    expect(
      ts.resolveModuleName("#src/local.ts", consumerSource, developmentConfig.options, ts.sys)
        .resolvedModule?.resolvedFileName,
    ).toBe(join(consumer, "src", "local.ts"));

    const compiler = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
    const developmentCheck = spawnSync(
      process.execPath,
      [compiler, "--noEmit", "-p", join(consumer, "tsconfig.json")],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(developmentCheck.status, developmentCheck.stderr || developmentCheck.stdout).toBe(0);
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
      ts.resolveModuleName("#src/local.ts", consumerSource, buildConfig.options, ts.sys)
        .resolvedModule?.resolvedFileName,
    ).toBe(join(consumer, "src", "local.ts"));
    const build = spawnSync(process.execPath, [compiler, "-b", "tsconfig.json"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);
    expect(
      ts.resolveModuleName("@fixture/provider", consumerSource, buildConfig.options, ts.sys)
        .resolvedModule?.resolvedFileName,
    ).toBe(join(provider, "dist", "index.d.ts"));
    const emitted = readFileSync(join(consumer, "dist", "index.js"), "utf8");
    expect(emitted).toContain('from "@fixture/provider"');
    expect(emitted).toContain('from "#src/local.ts"');
    expect(readFileSync(join(consumer, "dist", "index.d.ts"), "utf8")).toContain(
      "@fixture/provider",
    );
    expect(readFileSync(join(consumer, "dist", "index.d.ts"), "utf8")).toContain("#src/local.ts");
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

    for (const dir of [provider, consumer]) {
      const manifestFile = join(dir, "package.json");
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      delete manifest.imports["#src/*.ts"].bun;
      delete manifest.exports["."].bun;
      writeJson(manifestFile, manifest);
      rmSync(join(dir, "src"), { recursive: true });
    }
    const declarationConsumer = join(root, "declaration-consumer");
    mkdirSync(declarationConsumer);
    writeFileSync(
      join(declarationConsumer, "index.ts"),
      'import type { Marker, Local } from "@fixture/consumer";\nconst marker: Marker = "provider-source";\nconst local: Local = "relative-output";\nexport { marker, local };\n',
    );
    writeJson(join(declarationConsumer, "package.json"), { type: "module" });
    writeJson(join(declarationConsumer, "tsconfig.json"), {
      compilerOptions: {
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
      },
      include: ["index.ts"],
    });
    const declarationCheck = spawnSync(
      process.execPath,
      [compiler, "-p", join(declarationConsumer, "tsconfig.json")],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(declarationCheck.status, declarationCheck.stderr || declarationCheck.stdout).toBe(0);
    const outputOnlyRuntime = spawnSync(
      process.execPath,
      ["-e", 'import { value } from "@fixture/consumer"; console.log(value)'],
      { cwd: root, encoding: "utf8" },
    );
    expect(outputOnlyRuntime.status, outputOnlyRuntime.stderr).toBe(0);
    expect(outputOnlyRuntime.stdout.trim()).toBe("provider-source:relative-output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("application source aliases resolve .ts and .tsx and bundle independently of sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-private-app-"));
  try {
    const app = join(root, "app");
    mkdirSync(join(app, "src"), { recursive: true });
    writeJson(join(app, "package.json"), {
      name: "private-app",
      type: "module",
      imports: { "#src/*": "./src/*" },
    });
    writeFileSync(join(app, "src", "value.ts"), 'export const value = "application";\n');
    writeFileSync(join(app, "src", "view.tsx"), 'export const view = "tsx";\n');
    writeFileSync(
      join(app, "src", "index.ts"),
      'import { value } from "#src/value.ts";\nimport { view } from "#src/view.tsx";\nconsole.log(`${value}:${view}`);\n',
    );
    writeJson(join(app, "tsconfig.json"), {
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "preserve",
        noEmit: true,
        customConditions: ["bun"],
        allowImportingTsExtensions: true,
        strict: true,
      },
      include: ["src"],
    });
    const compiler = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
    const check = spawnSync(process.execPath, [compiler, "-p", join(app, "tsconfig.json")], {
      cwd: app,
      encoding: "utf8",
    });
    expect(check.status, check.stderr || check.stdout).toBe(0);
    const bundle = await Bun.build({
      entrypoints: [join(app, "src", "index.ts")],
      outdir: join(app, "dist"),
      target: "bun",
    });
    expect(bundle.success, bundle.logs.map(String).join("\n")).toBe(true);
    rmSync(join(app, "src"), { recursive: true });
    const runtime = spawnSync(process.execPath, [join(app, "dist", "index.js")], {
      cwd: app,
      encoding: "utf8",
    });
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(runtime.stdout.trim()).toBe("application:tsx");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
