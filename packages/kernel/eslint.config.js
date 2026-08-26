import { clarvisEslintConfig } from "../../eslint.config.base.js";

// kernel implements the async `KernelClient` service contracts (remote-ready signatures) with
// in-process bodies that are currently synchronous. The async signatures are the interface, not a
// bug — so `require-await` is relaxed here (same rationale as `code`); everything else is the base.
export default [
  ...clarvisEslintConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@clarvis/loop/internal",
              message: "Use @clarvis/loop, @clarvis/loop/host, or a capability subpath.",
            },
          ],
        },
      ],
    },
  },
];
