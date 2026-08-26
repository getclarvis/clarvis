import { describe, expect, it } from "bun:test";
import {
  POSIX_DEFAULT_ALLOWED_COMMANDS,
  WINDOWS_DEFAULT_ALLOWED_COMMANDS,
} from "@clarvis/kernel/local";
import { seedDefaultAllowlist } from "../../src/onboarding/seed-default-allowlist.ts";
import type { Scope, SettingsAdapter } from "../../src/adapters/settings.ts";

interface FakeOptions {
  files?: Partial<Record<Scope, boolean>>;
  corrupt?: Partial<Record<Scope, boolean>>;
  effective?: Record<string, unknown>;
  global?: Record<string, unknown>;
}

function fakeSettings(opts: FakeOptions = {}): SettingsAdapter & {
  writes: { scope: Scope; patch: Record<string, unknown> }[];
} {
  const writes: { scope: Scope; patch: Record<string, unknown> }[] = [];
  const files = { global: true, workspace: false, ...opts.files };
  const corrupt = { global: false, workspace: false, ...opts.corrupt };
  return {
    writes,
    effective: () => opts.effective ?? {},
    read: (scope: Scope) =>
      files[scope] ? (scope === "global" ? (opts.global ?? {}) : {}) : undefined,
    corrupt: (scope: Scope) => corrupt[scope] === true,
    write: async (scope: Scope, patch: Record<string, unknown>) => {
      writes.push({ scope, patch });
    },
  } as unknown as SettingsAdapter & {
    writes: { scope: Scope; patch: Record<string, unknown> }[];
  };
}

describe("seedDefaultAllowlist", () => {
  it("seeds the POSIX list on a POSIX host, where the guard is now on by default", async () => {
    // Before the guard defaulted to on, a POSIX host was left unseeded: the
    // guard was off, so an allow list bought nothing. Now an unseeded POSIX host
    // is the worst of both worlds — every command prompts, and the operator
    // learns to approve without reading.
    const settings = fakeSettings();
    const outcome = await seedDefaultAllowlist(settings, "linux");
    expect(outcome).toMatchObject({ seeded: true, scope: "global" });
    const guard = settings.writes[0]!.patch.guard as { allowed_commands: string[] };
    expect(guard.allowed_commands).toEqual([...POSIX_DEFAULT_ALLOWED_COMMANDS]);
    expect(guard.allowed_commands).toContain("git status");
  });

  it("picks the list by dialect, not by a shared lowest common denominator", async () => {
    const posix = fakeSettings();
    const windows = fakeSettings();
    await seedDefaultAllowlist(posix, "darwin");
    await seedDefaultAllowlist(windows, "win32");
    const listOf = (s: typeof posix): string[] =>
      (s.writes[0]!.patch.guard as { allowed_commands: string[] }).allowed_commands;
    expect(listOf(posix)).not.toEqual(listOf(windows));
    expect(listOf(windows)).toContain("Get-ChildItem");
    expect(listOf(posix)).not.toContain("Get-ChildItem");
  });

  it("writes the starter list into global settings on a fresh Windows host", async () => {
    const settings = fakeSettings();
    const outcome = await seedDefaultAllowlist(settings, "win32");
    expect(outcome).toMatchObject({ seeded: true, scope: "global" });
    expect(settings.writes).toHaveLength(1);
    const guard = settings.writes[0]!.patch.guard as { allowed_commands: string[]; type: string };
    expect(guard.type).toBe("shell");
    expect(guard.allowed_commands).toEqual([...WINDOWS_DEFAULT_ALLOWED_COMMANDS]);
  });

  it("never overwrites a list the user already has", async () => {
    const settings = fakeSettings({ effective: { guard: { allowed_commands: ["git status"] } } });
    expect(await seedDefaultAllowlist(settings, "win32")).toEqual({
      seeded: false,
      reason: "already-configured",
    });
    expect(settings.writes).toHaveLength(0);
  });

  it("treats an empty list as a deliberate choice, not an absent setting", async () => {
    // An empty allow list means "ask me about everything". Re-seeding it would
    // silently undo exactly the decision the user made.
    const settings = fakeSettings({ effective: { guard: { allowed_commands: [] } } });
    expect(await seedDefaultAllowlist(settings, "win32")).toEqual({
      seeded: false,
      reason: "already-configured",
    });
  });

  it("refuses to run before a settings file exists, or when one is corrupt", async () => {
    expect(
      await seedDefaultAllowlist(
        fakeSettings({ files: { global: false, workspace: false } }),
        "win32",
      ),
    ).toEqual({ seeded: false, reason: "no-settings-file" });
    expect(
      await seedDefaultAllowlist(fakeSettings({ corrupt: { global: true } }), "win32"),
    ).toEqual({ seeded: false, reason: "corrupt" });
  });

  it("seeds entries in the canonical form the analyzer produces", () => {
    // The guard matches `Segment.normalized`, where aliases have already been
    // rewritten — so an entry spelled `rm` or `ls` could never fire.
    const aliases = new Set(["rm", "ls", "cat", "cp", "mv", "del", "dir", "gc", "gci"]);
    for (const entry of WINDOWS_DEFAULT_ALLOWED_COMMANDS) {
      expect(aliases.has(entry.split(" ")[0]!)).toBe(false);
    }
  });
});

describe("the seed never launders workspace settings into global", () => {
  it("does not carry a repository's guard.mode into the operator's global block", async () => {
    // `guard` is deliberately not a workspace-trust risk field, so a cloned
    // repository's `{"guard":{"mode":"off"}}` does reach `effective()`. Spreading
    // the merged block into the global write would persist that repository's
    // opt-out onto the machine, disabling the guard for every workspace after.
    const settings = fakeSettings({ effective: { guard: { mode: "off" } }, global: {} });

    const outcome = await seedDefaultAllowlist(settings, "linux");

    expect(outcome).toMatchObject({ seeded: true, scope: "global" });
    const guard = settings.writes[0]!.patch.guard as { mode?: string };
    expect(guard.mode).toBeUndefined();
  });

  it("still preserves the operator's own global guard fields", async () => {
    const settings = fakeSettings({ global: { guard: { mode: "auto" } } });

    await seedDefaultAllowlist(settings, "linux");

    const guard = settings.writes[0]!.patch.guard as { mode?: string };
    expect(guard.mode).toBe("auto");
  });
});
