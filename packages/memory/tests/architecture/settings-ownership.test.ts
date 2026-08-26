/**
 * The settings contract, now that this package owns it outright.
 *
 * These assertions replace `packages/loop/tests/unit/memory-settings-drift.test.ts`,
 * which existed only because the block's zod shape and this capability's name were
 * declared twice — once here and once in the engine, which could not import an
 * optional package for a value. Both moved to `./settings.ts`, so there is one
 * owner and nothing left to drift. What is worth pinning instead is that the spec
 * really serves the *same* schema the store validates against, and that the
 * capability answers to the name the spec registers under.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createMemoryCapability } from "../../src/capability.ts";
import { memoryConfigSchema } from "../../src/schemas.ts";
import {
  MEMORY_CAPABILITY_NAME,
  MEMORY_INGEST_EVENT,
  MEMORY_REQUEST_PARAMS,
  memorySettingsSpec,
} from "../../src/settings.ts";

describe("memorySettingsSpec", () => {
  test("serves the store's own schema rather than a copy of it", () => {
    expect(memorySettingsSpec.schema).toBe(memoryConfigSchema);
  });

  test("registers under the capability's own name", () => {
    expect(memorySettingsSpec.key).toBe(MEMORY_CAPABILITY_NAME);
    expect(createMemoryCapability(undefined).name).toBe(MEMORY_CAPABILITY_NAME);
  });

  test("is lastWins and not plugin-contributable", () => {
    expect(memorySettingsSpec.merge).toBe("lastWins");
    expect(memorySettingsSpec.pluginContributable).toBe(false);
    expect(memorySettingsSpec.pluginDescription).toBeUndefined();
    expect(memorySettingsSpec.pluginForbiddenReason).toBeUndefined();
  });

  test("declares the per-run param the capability reads back", () => {
    expect(memorySettingsSpec.requestParams).toBe(MEMORY_REQUEST_PARAMS);
    const field = MEMORY_REQUEST_PARAMS.memory;
    expect(field.parse("on")).toBe("on");
    expect(field.parse("off")).toBe("off");
    expect(field.parse(undefined)).toBeUndefined();
    expect(() => field.parse("readonly")).toThrow(/memory must be 'on' or 'off'/);
  });
});

describe("the ingest event name", () => {
  test("is the kind the capability emits its notices under", () => {
    expect(MEMORY_INGEST_EVENT).toBe("ingest");
  });
});

/**
 * What `./settings` is allowed to reach.
 *
 * @remarks It is on the kernel's **eager** path — `config/capability-registry.ts`
 * registers `memorySettingsSpec` at module load — so anything it value-imports is
 * paid for on every import of the kernel, and `builtins` switching memory off
 * would stop meaning what it says. That includes an observability import: a
 * `Logger` value here would drag the logging module in for the sake of a module
 * that logs nothing, and a reach into `./factory.ts` or `./capability.ts` would
 * drag the whole package facade. Nothing else can see this — a static import is
 * a valid program and survives a green typecheck, lint and suite.
 */
describe("the settings module's import boundary", () => {
  const source = readFileSync(join(import.meta.dir, "..", "..", "src", "settings.ts"), "utf8");
  const valueImports = [...source.matchAll(/^\s*import\s+(?!type\s)[^\n]*?["']([^"']+)["']/gm)].map(
    (m) => m[1]!,
  );

  test("value-imports zod and its own schema module, and nothing else", () => {
    expect(valueImports.sort()).toEqual(["./schemas.ts", "zod"]);
  });

  test("names neither the factory nor the capability, even as a type", () => {
    expect(source).not.toContain("./factory.ts");
    expect(source).not.toContain("./capability.ts");
  });

  test("carries no logging key, because verbosity is never settings-configurable", () => {
    expect(source).not.toContain("Logger");
    expect(JSON.stringify(memoryConfigSchema.shape)).not.toContain("log");
  });
});
