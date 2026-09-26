import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleResolutionPolicyErrors } from "../../lib/module-resolution-policy.ts";

function fixture(
  run: (
    root: string,
    packages: Array<{
      name: string;
      dir: string;
      manifest: { exports: Record<string, unknown> };
      sourceEdges?: { file: string; specifier: string }[];
    }>,
  ) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "clarvis-resolution-policy-"));
  const consumer = join(root, "packages", "consumer");
  const provider = join(root, "packages", "provider");
  try {
    mkdirSync(join(consumer, "src"), { recursive: true });
    mkdirSync(join(provider, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "@clarvis"), { recursive: true });
    symlinkSync(provider, join(root, "node_modules", "@clarvis", "provider"), "dir");
    writeFileSync(
      join(consumer, "src", "index.ts"),
      'import { provider } from "@clarvis/provider";\nexport { provider };\n',
    );
    writeFileSync(join(provider, "src", "index.ts"), "export const provider = 1;\n");
    for (const dir of [consumer, provider]) {
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            customConditions: ["bun"],
          },
          include: ["src"],
        }),
      );
      writeFileSync(
        join(dir, "tsconfig.build.json"),
        JSON.stringify({
          extends: "./tsconfig.json",
          compilerOptions: {
            composite: true,
            noEmit: false,
            customConditions: [],
            declaration: true,
            rootDir: "src",
            outDir: "dist",
          },
          include: ["src"],
        }),
      );
    }
    const packages = [
      {
        name: "@clarvis/consumer",
        dir: consumer,
        manifest: {
          exports: {
            ".": { bun: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
          },
        },
        sourceEdges: [{ file: "packages/consumer/src/index.ts", specifier: "@clarvis/provider" }],
      },
      {
        name: "@clarvis/provider",
        dir: provider,
        manifest: {
          exports: {
            ".": { bun: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
          },
        },
      },
    ];
    writeFileSync(
      join(provider, "package.json"),
      JSON.stringify({ name: packages[1].name, type: "module", ...packages[1].manifest }),
    );
    run(root, packages);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("moduleResolutionPolicyErrors", () => {
  test("accepts export based source resolution without prior dist", () =>
    fixture((root, packages) => {
      expect(moduleResolutionPolicyErrors(root, packages)).toEqual([]);
    }));

  test("rejects effective aliases from direct and inherited paths", () =>
    fixture((root, packages) => {
      const consumer = packages[0].dir;
      writeFileSync(
        join(consumer, "base.json"),
        JSON.stringify({ compilerOptions: { paths: { "@clarvis/*": ["../provider/src/*"] } } }),
      );
      writeFileSync(
        join(consumer, "tsconfig.json"),
        JSON.stringify({
          extends: "./base.json",
          compilerOptions: {
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            customConditions: ["bun"],
          },
          include: ["src"],
        }),
      );
      const errors = moduleResolutionPolicyErrors(root, packages).join("\n");
      expect(errors).toContain(
        "packages/consumer/base.json (development @clarvis/*): workspace paths alias is forbidden",
      );
      writeFileSync(
        join(consumer, "tsconfig.json"),
        JSON.stringify({
          extends: "./base.json",
          compilerOptions: {
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            customConditions: ["bun"],
            paths: {},
          },
          include: ["src"],
        }),
      );
      expect(moduleResolutionPolicyErrors(root, packages)).toEqual([]);
    }));

  test("rejects an alias in the tooling CLI profile", () =>
    fixture((root, packages) => {
      const tooling = join(root, "tooling");
      mkdirSync(tooling);
      writeFileSync(join(tooling, "index.ts"), "export const check = 1;\n");
      writeFileSync(
        join(tooling, "tsconfig.check.json"),
        JSON.stringify({
          compilerOptions: {
            noEmit: true,
            customConditions: [],
            paths: { "@clarvis/provider": ["../packages/provider/src/index.ts"] },
          },
          include: ["index.ts"],
        }),
      );
      expect(moduleResolutionPolicyErrors(root, packages).join("\n")).toContain(
        "tooling/tsconfig.check.json (tooling @clarvis/provider): workspace paths alias is forbidden",
      );
    }));

  test("rejects bun leakage and invalid build output boundaries", () =>
    fixture((root, packages) => {
      const build = join(packages[0].dir, "tsconfig.build.json");
      writeFileSync(
        build,
        JSON.stringify({
          extends: "./tsconfig.json",
          compilerOptions: {
            composite: true,
            noEmit: true,
            declaration: true,
            rootDir: ".",
            outDir: "dist",
          },
          include: ["src"],
        }),
      );
      const errors = moduleResolutionPolicyErrors(root, packages).join("\n");
      expect(errors).toContain("build must set noEmit false");
      expect(errors).toContain("build must disable bun condition");
      expect(errors).toContain("build output must be confined");
    }));

  test("rejects a development profile without bun or noEmit", () =>
    fixture((root, packages) => {
      writeFileSync(
        join(packages[0].dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { target: "ESNext", module: "NodeNext", moduleResolution: "NodeNext" },
          include: ["src"],
        }),
      );
      const errors = moduleResolutionPolicyErrors(root, packages).join("\n");
      expect(errors).toContain("development must set noEmit true");
      expect(errors).toContain("development must enable bun condition");
    }));

  test("rejects export condition reordering and target drift", () =>
    fixture((root, packages) => {
      packages[1].manifest.exports["."] = {
        types: "./dist/wrong.d.ts",
        bun: "./src/index.ts",
        import: "./dist/wrong.js",
      };
      const errors = moduleResolutionPolicyErrors(root, packages).join("\n");
      expect(errors).toContain("bun must precede types in exports");
      expect(errors).toContain("types target does not match bun source");
      expect(errors).toContain("import target does not match emitted JavaScript");
    }));

  test("rejects a missing source selected by exports", () =>
    fixture((root, packages) => {
      packages[1].manifest.exports["."] = {
        bun: "./src/missing.ts",
        types: "./dist/missing.d.ts",
        import: "./dist/missing.js",
      };
      expect(moduleResolutionPolicyErrors(root, packages).join("\n")).toContain(
        "bun source does not exist",
      );
    }));

  test("resolves a public wildcard without a parallel subpath list", () =>
    fixture((root, packages) => {
      const provider = packages[1];
      mkdirSync(join(provider.dir, "src", "features"));
      writeFileSync(join(provider.dir, "src", "features", "one.ts"), "export const one = 1;\n");
      provider.manifest.exports["./features/*"] = {
        bun: "./src/features/*.ts",
        types: "./dist/features/*.d.ts",
        import: "./dist/features/*.js",
      };
      writeFileSync(
        join(provider.dir, "package.json"),
        JSON.stringify({ name: provider.name, type: "module", ...provider.manifest }),
      );
      packages[0].sourceEdges = [
        { file: "packages/consumer/src/index.ts", specifier: "@clarvis/provider/features/one" },
      ];
      expect(moduleResolutionPolicyErrors(root, packages)).toEqual([]);
    }));
});
