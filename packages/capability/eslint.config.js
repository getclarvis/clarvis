import { clarvisEslintConfig } from "../../eslint.config.base.js";

export default [
  ...clarvisEslintConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ["src/tasks.ts"],
    rules: {
      // These are the two primitives that turn a promise into an intentionally safe void task.
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
    },
  },
];
