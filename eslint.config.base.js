// Shared ESLint flat config for all @clarvis packages.
// Each package's eslint.config.js calls clarvisEslintConfig({ tsconfigRootDir: import.meta.dirname })
// and may append package-specific config objects after it (last-wins). `code` layers on
// eslint-plugin-unicorn + a few dynamic-boundary rule relaxations; protocol/kernel use it as-is.
import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Canonical Clarvis ESLint flat config.
 * @param {{ tsconfigRootDir: string, project?: string[] }} opts
 *   tsconfigRootDir — the package dir (pass `import.meta.dirname`).
 *   project — tsconfig(s) that provide type information for type-checked rules
 *             (defaults to the package's `./tsconfig.json`).
 */
export function clarvisEslintConfig({ tsconfigRootDir, project = ["./tsconfig.json"] }) {
  return defineConfig(
    globalIgnores(["dist/", "coverage/", "node_modules/"]),
    js.configs.recommended,
    tseslint.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        ecmaVersion: 2026,
        sourceType: "module",
        globals: {
          ...globals.node,
        },
        parserOptions: {
          project,
          tsconfigRootDir,
        },
      },
      rules: {
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
        ],
        "@typescript-eslint/consistent-type-imports": "error",
        "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
        "no-empty": ["error", { allowEmptyCatch: true }],
      },
    },
    {
      // Test files legitimately traffic in untyped fixtures/mocks; relax the type-safety family there.
      files: ["tests/**/*.{ts,tsx}"],
      rules: {
        "@typescript-eslint/only-throw-error": "off",
        "@typescript-eslint/require-await": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unnecessary-type-assertion": "off",
        "@typescript-eslint/no-redundant-type-constituents": "off",
        "@typescript-eslint/no-explicit-any": "off",
        // Bun's promise matchers are tracked by the runner but typed as synchronous.
        "@typescript-eslint/await-thenable": "off",
        "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      },
    },
  );
}
