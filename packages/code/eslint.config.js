import { clarvisEslintConfig } from "../../eslint.config.base.js";
import unicorn from "eslint-plugin-unicorn";

// code layers on top of the shared base: it adds eslint-plugin-unicorn for its file-naming
// convention, and relaxes the no-unsafe-*
// family in src for its two inherently dynamic boundaries (MCP tool-call args + wire responses),
// where values are legitimately `unknown` and per-tool arg schemas would buy nothing.
export default [
  ...clarvisEslintConfig({
    tsconfigRootDir: import.meta.dirname,
    project: ["./tsconfig.json"],
  }),
  {
    plugins: { unicorn },
    rules: {
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-base-to-string": "off",
      // Several adapters are async by interface (I/O contract) but use sync fs under the hood; an
      // async signature there is intentional, not a bug this rule should force us to unwind.
      "@typescript-eslint/require-await": "off",
      // PascalCase for Solid component files (App.tsx, Sidebar.tsx), kebab-case for logic/adapters.
      "unicorn/filename-case": ["error", { cases: { pascalCase: true, kebabCase: true } }],
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["src/core/tasks.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
    },
  },
  // Architecture boundaries (see specs/hosts/code-bootstrap.md §1 and INV-CB-5..CB-10):
  // orchestration + adapters must not depend on presentation; core is framework-free.
  {
    files: ["src/adapters/**/*.{ts,tsx}", "src/run-host.ts", "src/cli-mode.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: String.raw`(^|[./])views(/|$)`,
              message:
                "adapters/run-host/cli-mode must not import views/ — use core contracts instead",
            },
            {
              regex: String.raw`(^|[./])ui(/|$)`,
              message: "adapters/run-host/cli-mode must not import ui/",
            },
            {
              // Presentation theme modules (Solid tokens, glyphs UI). Neutral config
              // lives in core/theme-types — adapters must use that instead of theme/.
              regex: String.raw`(^|[./])theme(/|$)`,
              message:
                "adapters/run-host/cli-mode must not import theme/ — use core/theme-types or core/marks",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "solid-js",
              message: "core must stay framework-free",
            },
          ],
          patterns: [
            {
              group: ["solid-js/*", "@opentui/*"],
              message: "core must stay framework-free",
            },
            {
              regex: String.raw`(^|[./])(views|ui|theme|adapters|infrastructure)(/|$)`,
              message: "core must not import views, theme, ui, adapters, or infrastructure",
            },
          ],
        },
      ],
    },
  },
  // keys/ owns the keymap registry but must stay free of view implementation.
  {
    files: ["src/keys/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: String.raw`(^|[./])views(/|$)`,
              message: "keys must not import views/ — register views at the app/feature edge",
            },
            {
              regex: String.raw`(^|[./])ui(/|$)`,
              message: "keys must not import ui/",
            },
          ],
        },
      ],
    },
  },
  // ui primitives/patterns/overlays must not depend on features or kernel services.
  {
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@clarvis/kernel", "@clarvis/kernel/*"],
              message: "ui must not import kernel services",
            },
            {
              regex: String.raw`(^|[./])features(/|$)`,
              message: "ui must not import features/",
            },
            {
              regex: String.raw`(^|[./])adapters(/|$)`,
              message: "ui must not import adapters/",
            },
            {
              regex: String.raw`(^|[./])views(/|$)`,
              message: "ui must not import legacy views/",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/infrastructure/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: String.raw`(^|[./])(views|ui)(/|$)`,
              message: "infrastructure must not import presentation modules",
            },
          ],
        },
      ],
    },
  },
  // One feature cannot import another feature's modules.
  // Match only one-level sibling paths (`../providers/...`), not `../../adapters`.
  // Shared helpers at features/issues.ts remain allowed.
  {
    files: ["src/features/*/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: String.raw`^\.\./(?!\.\./)(?!issues(?:\.ts)?$)[a-z0-9-]+/`,
              message:
                "features must not import another feature's modules; coordinate via app or shared core",
            },
          ],
        },
      ],
    },
  },
];
