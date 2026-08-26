import { clarvisEslintConfig } from "../../eslint.config.base.js";

export default [
  ...clarvisEslintConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@clarvis/loop/internal",
              message: "Use @clarvis/loop or its supported workflows adapter subpath.",
            },
          ],
        },
      ],
    },
  },
];
