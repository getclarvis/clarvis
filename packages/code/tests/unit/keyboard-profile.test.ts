import { describe, expect, test } from "bun:test";
import type { HostMetadata } from "@opentui/keymap";
import {
  applyManualBindingEdit,
  buildKeyboardEnvironment,
  defaultKeyboardProfile,
  effectiveClientPlatform,
  keyboardEnvironmentId,
  normalizeKeyboardConfig,
  resolveCommandBindings,
  validateManualBindings,
  type KeyboardEnvironmentInput,
} from "../../src/keys/keyboard-profile.ts";

const host: HostMetadata = {
  platform: "linux",
  primaryModifier: "ctrl",
  modifiers: {
    ctrl: "supported",
    shift: "supported",
    meta: "supported",
    super: "unknown",
    hyper: "unknown",
  },
};

function input(patch: Partial<KeyboardEnvironmentInput> = {}): KeyboardEnvironmentInput {
  return {
    remote: false,
    runtimePlatform: "linux",
    terminal: { name: "xterm-kitty", version: "0.40" },
    kittyKeyboard: true,
    multiplexer: "none",
    host,
    ...patch,
  };
}

describe("automatic keyboard profiles", () => {
  test("only local Kitty input opts into enhanced bindings automatically", () => {
    expect(defaultKeyboardProfile(input())).toBe("enhanced");
    expect(defaultKeyboardProfile(input({ kittyKeyboard: false }))).toBe("portable");
    expect(defaultKeyboardProfile(input({ remote: true }))).toBe("portable");
  });

  test("remote runtime platform is not presented as the client convention", () => {
    const remote = buildKeyboardEnvironment(input({ remote: true, runtimePlatform: "linux" }));
    expect(remote.profile).toBe("portable");
    expect(effectiveClientPlatform(remote)).toBeUndefined();

    const explicit = buildKeyboardEnvironment(input({ remote: true }), {
      profile: "manual",
      clientPlatform: "macos",
    });
    expect(effectiveClientPlatform(explicit)).toBe("macos");
  });

  test("saved verdicts replace host guesses without retaining raw input", () => {
    const environment = buildKeyboardEnvironment(input({ remote: true, kittyKeyboard: false }), {
      profile: "enhanced",
      verdicts: { meta: "unsupported", super: "supported", baseLayout: "supported" },
    });
    expect(environment).toMatchObject({
      transport: "ssh",
      protocol: "legacy",
      profile: "enhanced",
      baseLayout: "supported",
      modifiers: { meta: "unsupported", super: "supported" },
    });
  });
});

test("keyboardEnvironmentId is stable, opaque and changes with path dimensions", () => {
  const id = keyboardEnvironmentId(input());
  expect(id).toMatch(/^[a-f0-9]{24}$/);
  expect(id).toBe(keyboardEnvironmentId(input()));
  expect(id).not.toBe(keyboardEnvironmentId(input({ remote: true })));
  expect(id).not.toContain("kitty");
});

test("keyboardEnvironmentId survives a terminal-emulator version bump", () => {
  // A version is not a compatibility dimension. Hashing it minted a new id on
  // every emulator patch release, which orphaned that path's saved profile,
  // manual bindings and verdicts — the accelerators simply stopped — and left one
  // unreachable `environments` record behind per version.
  const base = keyboardEnvironmentId(input({ terminal: { name: "ghostty", version: "1.1.2" } }));
  expect(base).toBe(
    keyboardEnvironmentId(input({ terminal: { name: "ghostty", version: "1.1.3" } })),
  );
  expect(base).toBe(keyboardEnvironmentId(input({ terminal: { name: "ghostty" } })));
  expect(base).not.toBe(keyboardEnvironmentId(input({ terminal: { name: "kitty" } })));
});

describe("applyManualBindingEdit", () => {
  const known = new Set(["safety.picker", "app.escape", "transcript.focusPrev"]);

  test("clearing the last override removes the map instead of writing it back", () => {
    const result = applyManualBindingEdit({
      saved: { profile: "manual", bindings: { "safety.picker": ["ctrl+b"] } },
      command: "safety.picker",
      keys: [],
      knownCommands: known,
    });
    expect(result.issues).toBeUndefined();
    expect(result.config).toEqual({ profile: "manual" });
    expect(result.config).not.toHaveProperty("bindings");
  });

  test("clearing one of several overrides keeps the rest", () => {
    const result = applyManualBindingEdit({
      saved: {
        profile: "manual",
        bindings: { "safety.picker": ["ctrl+b"], "transcript.focusPrev": ["f7"] },
      },
      command: "safety.picker",
      keys: [],
      knownCommands: known,
    });
    expect(result.config?.bindings).toEqual({ "transcript.focusPrev": ["f7"] });
  });

  test("a stale entry for an unregistered command does not block an unrelated edit", () => {
    // The MCP server that registered `mcp.foo.prompt` was removed from settings,
    // so it is no longer a known command. Reporting it here blocked every later
    // edit — including clearing that very entry — and named a command the user
    // had not touched.
    const saved = { profile: "manual" as const, bindings: { "mcp.foo.prompt": ["f9"] } };
    const result = applyManualBindingEdit({
      saved,
      command: "safety.picker",
      keys: ["ctrl+b"],
      knownCommands: known,
    });
    expect(result.issues).toBeUndefined();
    expect(result.config?.bindings).toEqual({
      "mcp.foo.prompt": ["f9"],
      "safety.picker": ["ctrl+b"],
    });
    // And the stale entry itself can now be cleared.
    expect(
      applyManualBindingEdit({
        saved,
        command: "mcp.foo.prompt",
        keys: [],
        knownCommands: known,
      }).config,
    ).toEqual({ profile: "manual" });
  });

  test("the edited command's own issues still block the write", () => {
    expect(
      applyManualBindingEdit({
        saved: { profile: "manual" },
        command: "safety.picker",
        keys: ["escape"],
        knownCommands: known,
      }).issues,
    ).toEqual([
      {
        command: "safety.picker",
        key: "escape",
        message: "binding shadows app.escape",
        shadows: "app.escape",
      },
    ]);
    // `ctrl+notakey` is modifier-shaped, so only the keymap's own parser can
    // reject it — which is why the caller reports it through `invalidKeys`.
    expect(
      applyManualBindingEdit({
        saved: { profile: "manual" },
        command: "safety.picker",
        keys: ["ctrl+notakey"],
        knownCommands: known,
        invalidKeys: ["ctrl+notakey"],
      }).issues,
    ).toEqual([{ command: "safety.picker", key: "ctrl+notakey", message: "invalid key sequence" }]);
  });

  test("an edit adopts the manual profile and preserves the rest of the record", () => {
    const result = applyManualBindingEdit({
      saved: { profile: "portable", clientPlatform: "macos", verdicts: { ctrl: "supported" } },
      command: "safety.picker",
      keys: ["ctrl+b"],
      knownCommands: known,
    });
    expect(result.config).toEqual({
      profile: "manual",
      clientPlatform: "macos",
      verdicts: { ctrl: "supported" },
      bindings: { "safety.picker": ["ctrl+b"] },
    });
  });
});

test("binding resolution keeps portable routes and gates enhanced alternatives", () => {
  const candidates = [
    { key: "f7" },
    { key: "super+k", minimumProfile: "enhanced" as const, requires: ["super" as const] },
    { key: "alt+k", minimumProfile: "enhanced" as const, requires: ["meta" as const] },
  ];
  const portable = buildKeyboardEnvironment(input({ remote: true }));
  expect(resolveCommandBindings("custom.command", candidates, portable)).toEqual(["f7"]);

  const enhanced = buildKeyboardEnvironment(input());
  expect(resolveCommandBindings("custom.command", candidates, enhanced)).toEqual(["alt+k", "f7"]);

  const manual = buildKeyboardEnvironment(input({ remote: true }), { profile: "manual" });
  expect(
    resolveCommandBindings("custom.command", candidates, manual, {
      "custom.command": ["ctrl+h"],
    }),
  ).toEqual(["ctrl+h"]);
});

test("unsupported capabilities suppress enhanced candidates even in an explicit profile", () => {
  const environment = buildKeyboardEnvironment(input(), {
    profile: "enhanced",
    verdicts: { super: "unsupported" },
  });
  expect(
    resolveCommandBindings(
      "custom.command",
      [{ key: "f7" }, { key: "super+p", minimumProfile: "enhanced", requires: ["super"] }],
      environment,
    ),
  ).toEqual(["f7"]);
});

test("manual binding validation catches unknown commands, collisions, syntax and vital unbinds", () => {
  const issues = validateManualBindings(
    {
      "app.escape": [],
      "run.cancel": ["ctrl+h"],
      "custom.destination": ["CTRL+H"],
      "missing.command": ["f8"],
      "custom.invalid": ["ctrl++c"],
    },
    new Set(["app.escape", "custom.destination", "custom.invalid", "run.cancel"]),
  );
  expect(issues.map((issue) => issue.message)).toEqual([
    "protected action cannot be unbound",
    "binding shadows run.cancel",
    "unknown command",
    "invalid key sequence",
  ]);
  expect(
    validateManualBindings({ "custom.destination": ["f1"] }, new Set(["custom.destination"])),
  ).toEqual([]);
});

test("normalizeKeyboardConfig tolerates future and malformed UI data", () => {
  expect(normalizeKeyboardConfig(null)).toEqual({ version: 1, environments: {} });
  expect(
    normalizeKeyboardConfig({
      version: 1,
      environments: {
        abc: {
          profile: "manual",
          clientPlatform: "macos",
          verdicts: { ctrl: "supported", bogus: "supported" },
          bindings: { "custom.destination": ["f8", 42, ""] },
        },
        bad: { profile: "turbo" },
      },
    }),
  ).toEqual({
    version: 1,
    environments: {
      abc: {
        profile: "manual",
        clientPlatform: "macos",
        verdicts: { ctrl: "supported" },
        bindings: { "custom.destination": ["f8"] },
      },
    },
  });
});

describe("shadowing a vital action", () => {
  const known = new Set(["app.quit", "app.escape", "run.cancel"]);

  test("an alias spelling of a reserved key is still a shadow", () => {
    // The comparison was between raw lower-cased strings, so `esc` and `escape`
    // read as two different keys and an ordinary command could quietly take a
    // vital action's binding by spelling it the other way.
    const normalize = (key: string): string =>
      key.trim().toLowerCase() === "esc" ? "escape" : key.trim().toLowerCase();
    const issues = validateManualBindings({ "app.quit": ["esc"] }, known, normalize);
    expect(issues.map((issue) => issue.message)).toEqual(["binding shadows app.escape"]);
    // The fallback normalizer catches it too. It used to return `[]` here, and a
    // default that silently drops a safety check is a bypass rather than a
    // simplification: an injected normalizer still wins, but not injecting one
    // no longer hands an ordinary command a protected key.
    expect(validateManualBindings({ "app.quit": ["esc"] }, known).map((i) => i.message)).toEqual([
      "binding shadows app.escape",
    ]);
  });

  test("a normalizer that throws falls back rather than losing the check", () => {
    const issues = validateManualBindings({ "app.quit": ["escape"] }, known, () => {
      throw new Error("unparsable");
    });
    expect(issues.map((issue) => issue.message)).toEqual(["binding shadows app.escape"]);
  });

  test("the edit is refused even when the vital action is the one reported", () => {
    // Shadowing is reported against whichever command is seen second, so when
    // the edited command claimed the key first the complaint landed on the vital
    // action and the edited-command filter dropped it.
    const result = applyManualBindingEdit({
      saved: { profile: "manual", bindings: { "app.escape": ["escape"] } },
      command: "app.quit",
      keys: ["escape"],
      knownCommands: known,
    });
    expect(result.config).toBeUndefined();
    expect(result.issues?.[0]?.message).toContain("shadows");
  });

  test("a protected action cannot be the delayed prefix of a manual sequence", () => {
    for (const key of ["escape x", "esc x"]) {
      const result = applyManualBindingEdit({
        saved: undefined,
        command: "app.quit",
        keys: [key],
        knownCommands: known,
      });
      expect(result.issues).toEqual([
        {
          command: "app.quit",
          key,
          message: "binding has an ambiguous prefix with app.escape",
          shadows: "app.escape",
        },
      ]);
    }
    expect(
      applyManualBindingEdit({
        saved: undefined,
        command: "app.quit",
        keys: ["ctrl+c x"],
        knownCommands: known,
      }).issues?.[0]?.message,
    ).toBe("binding has an ambiguous prefix with run.cancel");
  });
});

test("an alias spelling cannot take a protected action's key", () => {
  const known = new Set(["app.quit", "app.escape", "run.cancel"]);
  // `escape` was refused while `esc` was accepted, so an ordinary command took
  // Escape by spelling it the other way — the exact bypass the normalizer
  // exists to close.
  for (const key of ["escape", "Escape", "esc", "ESC"]) {
    const result = applyManualBindingEdit({
      saved: undefined,
      command: "app.quit",
      keys: [key],
      knownCommands: known,
    });
    expect(result.issues?.[0]?.message).toContain("shadows app.escape");
  }
});

test("protected keys are refused by every spelling, and F1 remains available", () => {
  const known = new Set(["app.quit", "app.escape", "run.cancel"]);
  const edit = (key: string): ReturnType<typeof applyManualBindingEdit> =>
    applyManualBindingEdit({
      saved: undefined,
      command: "app.quit",
      keys: [key],
      knownCommands: known,
    });
  expect(edit("f1").issues).toBeUndefined();
  expect(edit("ctrl+c").issues?.[0]?.message).toContain("shadows run.cancel");
  expect(edit("ctrl+shift+q").issues).toBeUndefined();
});
