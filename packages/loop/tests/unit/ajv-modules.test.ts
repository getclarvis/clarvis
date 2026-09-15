import { describe, expect, it } from "../bun-test.ts";
import { Ajv } from "ajv";
import * as formatsModule from "ajv-formats";

import { installBundledAjvModules } from "../../src/validation/ajv.ts";

describe("bundled Ajv module installation", () => {
  it("keeps the first runtime module identity immutable", () => {
    const install = () =>
      installBundledAjvModules({ Ajv, addFormats: formatsModule.default.default });
    try {
      install();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    expect(install).toThrow("already installed");
  });
});
