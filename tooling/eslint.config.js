import { clarvisEslintConfig } from "../eslint.config.base.js";

export default [
  ...clarvisEslintConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ["tooling/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    files: ["tooling/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
    },
  },
];
