import { describe, expect, test } from "bun:test";
import {
  acceptMention,
  slashTokenMatches,
  clampIndex,
  classifySlashSubmit,
  detectTrigger,
  parseBangCommand,
  parseSlashCommand,
  slashCompletion,
  splitSlashArgs,
} from "../../src/views/input/autocomplete.ts";
import { windowGroupedRows, windowRows } from "../../src/ui/patterns/windowed-list.tsx";

test("parseSlashCommand: splits a slash command into name and trailing args", () => {
  expect(parseSlashCommand("/commit")).toEqual({ name: "commit", args: "" });
  expect(parseSlashCommand("/commit fix the null check")).toEqual({
    name: "commit",
    args: "fix the null check",
  });
  expect(parseSlashCommand("  /commit  focus here  ")).toEqual({
    name: "commit",
    args: "focus here",
  });
});

test("parseSlashCommand: non-slash text and a bare slash → null", () => {
  expect(parseSlashCommand("hello")).toBeNull();
  expect(parseSlashCommand("say /commit")).toBeNull();
  expect(parseSlashCommand("/")).toBeNull();
  expect(parseSlashCommand("/   ")).toBeNull();
});

test("classifySlashSubmit: skill > registered command > unknown; path-like heads stay chat", () => {
  const opts = {
    skillAgent: (n: string) => (n === "review" ? "reviewer" : undefined),
    findCommand: (slash: string) =>
      ({ "/export": "session.export", "/mcp:prompt": "mcp:prompt" })[slash],
  };
  expect(classifySlashSubmit("review", opts)).toEqual({ kind: "skill", agent: "reviewer" });
  expect(classifySlashSubmit("export", opts)).toEqual({
    kind: "command",
    command: "session.export",
  });
  expect(classifySlashSubmit("mcp:prompt", opts)).toEqual({
    kind: "command",
    command: "mcp:prompt",
  });
  expect(classifySlashSubmit("exprot", opts)).toEqual({ kind: "unknown" });
  expect(classifySlashSubmit("etc/hosts", opts)).toEqual({ kind: "chat" });
  expect(classifySlashSubmit("étoile", opts)).toEqual({ kind: "chat" });
});

test("parseBangCommand: strips the bang and trims the command", () => {
  expect(parseBangCommand("! ls -la")).toBe("ls -la");
  expect(parseBangCommand("  !ls")).toBe("ls");
  expect(parseBangCommand("!!date")).toBe("!date");
  expect(parseBangCommand("!")).toBe("");
  expect(parseBangCommand("!   ")).toBe("");
});

test("parseBangCommand: non-leading bang is not a command", () => {
  expect(parseBangCommand("say ! hi")).toBeNull();
  expect(parseBangCommand("hello")).toBeNull();
  expect(parseBangCommand("")).toBeNull();
});

test("a bang line never opens the autocomplete popup", () => {
  expect(detectTrigger("! ls", ["/", "/config", "@"])).toBeNull();
});

test("detectTrigger: fires on a leading trigger char and captures the term", () => {
  expect(detectTrigger("/cl", ["/"])).toEqual({ trigger: "/", term: "cl" });
  expect(detectTrigger("/", ["/"])).toEqual({ trigger: "/", term: "" });
  expect(detectTrigger("@src", ["/", "@"])).toEqual({ trigger: "@", term: "src" });
});

test("detectTrigger: no trigger, empty text, or non-leading trigger → null", () => {
  expect(detectTrigger("", ["/"])).toBeNull();
  expect(detectTrigger("hello", ["/"])).toBeNull();
  expect(detectTrigger("a/b", ["/"])).toBeNull();
});

test("detectTrigger: a whitespace after the trigger completes the token → null", () => {
  expect(detectTrigger("/clear now", ["/"])).toBeNull();
  expect(detectTrigger("/ ", ["/"])).toBeNull();
});

test("detectTrigger: a compound trigger continues matching after the space if registered", () => {
  expect(detectTrigger("/config", ["/", "/config"])).toEqual({ trigger: "/", term: "config" });
  expect(detectTrigger("/config ", ["/", "/config"])).toEqual({ trigger: "/config", term: "" });
  expect(detectTrigger("/config providers", ["/", "/config"])).toEqual({
    trigger: "/config",
    term: "providers",
  });
});

test("detectTrigger: an unregistered compound trigger still closes the popup", () => {
  expect(detectTrigger("/clear now", ["/", "/config"])).toBeNull();
});

test("detectTrigger: @ completes inside a slash line with a non-composite head", () => {
  const triggers = ["/", "/config", "@"];
  expect(detectTrigger("/skill @src/fi", triggers)).toEqual({ trigger: "@", term: "src/fi" });
  expect(detectTrigger("/skill fix the bug in @src/app", triggers)).toEqual({
    trigger: "@",
    term: "src/app",
  });
  expect(detectTrigger("/skill plain words", triggers)).toBeNull();
});

test("detectTrigger: an explicit @ in the tail outranks even a composite head", () => {
  expect(detectTrigger("/config @src/x", ["/", "/config", "@"])).toEqual({
    trigger: "@",
    term: "src/x",
  });
  expect(detectTrigger("/config providers", ["/", "/config", "@"])).toEqual({
    trigger: "/config",
    term: "providers",
  });
});

test("splitSlashArgs: one token per argument, the last one takes the remainder", () => {
  expect(splitSlashArgs("", 2)).toEqual([]);
  expect(splitSlashArgs("only", 0)).toEqual([]);
  expect(splitSlashArgs("free text stays whole", 1)).toEqual(["free text stays whole"]);
  expect(splitSlashArgs("a b", 2)).toEqual(["a", "b"]);
  expect(splitSlashArgs("src/app.ts fix the null check", 2)).toEqual([
    "src/app.ts",
    "fix the null check",
  ]);
  expect(splitSlashArgs("  padded   out  ", 2)).toEqual(["padded", "out"]);
  expect(splitSlashArgs("just-one", 3)).toEqual(["just-one"]);
});

test("detectTrigger: a mid-message token that merely starts with a slash trigger does not fire", () => {
  expect(detectTrigger("edit /config/app.json", ["/", "/config", "@"])).toBeNull();
  expect(detectTrigger("run /configure.sh", ["/", "/config", "@"])).toBeNull();
  expect(detectTrigger("path /configuration/x", ["/", "/config", "@"])).toBeNull();
  expect(detectTrigger("see @src/app.ts", ["/", "/config", "@"])).toEqual({
    trigger: "@",
    term: "src/app.ts",
  });
});

test("clampIndex: bounds to [0, len-1], zero on empty", () => {
  expect(clampIndex(5, 3)).toBe(2);
  expect(clampIndex(-1, 3)).toBe(0);
  expect(clampIndex(1, 3)).toBe(1);
  expect(clampIndex(2, 0)).toBe(0);
});

test("windowRows: a list that fits shows everything, no scroll indicators", () => {
  const items = ["a", "b", "c"];
  expect(windowRows(items, 0, 8)).toEqual({ rows: ["a", "b", "c"], offset: 0, above: 0, below: 0 });
  expect(windowRows(items, 2, 8)).toEqual({ rows: ["a", "b", "c"], offset: 0, above: 0, below: 0 });
});

test("windowRows: a long list keeps the selection on screen at a CONSTANT total height", () => {
  const items = Array.from({ length: 15 }, (_, i) => `c${i}`);
  const lines = (w: ReturnType<typeof windowRows<string>>): number =>
    w.rows.length + (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0);
  const top = windowRows(items, 0, 8);
  expect(top).toMatchObject({ offset: 0, above: 0, below: 8 });
  expect(top.rows).toHaveLength(7);
  expect(lines(top)).toBe(8);
  const mid = windowRows(items, 7, 8);
  expect(7 - mid.offset).toBeGreaterThanOrEqual(0);
  expect(7 - mid.offset).toBeLessThan(mid.rows.length);
  expect(mid.above).toBeGreaterThan(0);
  expect(mid.below).toBeGreaterThan(0);
  expect(lines(mid)).toBe(8);
  const end = windowRows(items, 14, 8);
  expect(end).toMatchObject({ offset: 8, above: 8, below: 0 });
  expect(end.rows[end.rows.length - 1]).toBe("c14");
  expect(lines(end)).toBe(8);
  for (let i = 0; i < items.length; i++) {
    const w = windowRows(items, i, 8);
    expect(lines(w)).toBe(8);
    expect(i - w.offset).toBeGreaterThanOrEqual(0);
    expect(i - w.offset).toBeLessThan(w.rows.length);
  }
});

test("windowRows: degenerate inputs (empty list / zero width)", () => {
  expect(windowRows([], 0, 8)).toEqual({ rows: [], offset: 0, above: 0, below: 0 });
  expect(windowRows(["a", "b"], 0, 0)).toEqual({ rows: [], offset: 0, above: 0, below: 0 });
});

test("windowRows: scroll mode uses the whole viewport without indicator rows", () => {
  const items = Array.from({ length: 8 }, (_, index) => index);
  expect(windowRows(items, 0, 3, "scroll")).toEqual({
    rows: [0, 1, 2],
    offset: 0,
    above: 0,
    below: 5,
  });
  expect(windowRows(items, 5, 3, "scroll")).toEqual({
    rows: [3, 4, 5],
    offset: 3,
    above: 3,
    below: 2,
  });
});

interface G {
  group?: string;
}

test("windowGroupedRows: a list that fits gets one header entry per group boundary", () => {
  const items: G[] = [{ group: "A" }, { group: "A" }, { group: "B" }, { group: "B" }];
  const w = windowGroupedRows(items, 0, 8);
  expect(w.rows).toHaveLength(4);
  expect(w.headers).toEqual(["A", undefined, "B", undefined]);
});

test("windowGroupedRows: the item budget shrinks to make room for header lines", () => {
  const items: G[] = [{ group: "A" }, { group: "A" }, { group: "B" }, { group: "B" }];
  const w = windowGroupedRows(items, 0, 4);
  const headerCount = w.headers.filter((h) => h !== undefined).length;
  const indicatorLines = (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0);
  expect(w.rows.length + headerCount + indicatorLines).toBeLessThanOrEqual(4);
});

test("windowGroupedRows: total rendered lines never exceed max, across every scroll position", () => {
  const items: G[] = [
    ...Array.from({ length: 3 }, () => ({ group: "Actions" })),
    ...Array.from({ length: 4 }, () => ({ group: "Go to" })),
    ...Array.from({ length: 2 }, () => ({ group: "Skills" })),
    ...Array.from({ length: 3 }, () => ({ group: "MCP prompts" })),
  ];
  for (const max of [4, 5, 6, 8, 12]) {
    for (let i = 0; i < items.length; i++) {
      const w = windowGroupedRows(items, i, max);
      const headerCount = w.headers.filter((h) => h !== undefined).length;
      const indicatorLines = (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0);
      expect(w.rows.length + headerCount + indicatorLines).toBeLessThanOrEqual(max);
      expect(i - w.offset).toBeGreaterThanOrEqual(0);
      expect(i - w.offset).toBeLessThan(w.rows.length);
    }
  }
});

test("windowGroupedRows: a window that starts mid-group still reports that group's header (sticky)", () => {
  const items: G[] = Array.from({ length: 10 }, () => ({ group: "Solo" }));
  const w = windowGroupedRows(items, 9, 4);
  expect(w.offset).toBeGreaterThan(0);
  expect(w.headers[0]).toBe("Solo");
});

test("windowGroupedRows: scroll mode spends the line budget only on rows and headers", () => {
  const items: G[] = Array.from({ length: 8 }, () => ({ group: "Solo" }));
  const w = windowGroupedRows(items, 5, 4, "scroll");
  const headerCount = w.headers.filter((header) => header !== undefined).length;
  expect(w.rows.length + headerCount).toBeLessThanOrEqual(4);
  expect(w.above).toBeGreaterThan(0);
  expect(w.below).toBeGreaterThan(0);
  expect(w.rows).toContain(items[5]!);
});

test("slashCompletion: Tab fills the exact command with no trailing space (popup stays open, Enter runs)", () => {
  expect(slashCompletion("/help")).toBe("/help");
  expect(detectTrigger(slashCompletion("/help"), ["/", "@"])).toEqual({
    trigger: "/",
    term: "help",
  });
  expect(parseSlashCommand(slashCompletion("/help"))).toEqual({ name: "help", args: "" });
});

test("acceptMention replaces the current word using detectTrigger's boundary rule", () => {
  expect(acceptMention("see @re", "@", "src/x.ts")).toBe("see @src/x.ts ");
  expect(acceptMention("@re", "@", "a.png")).toBe("@a.png ");
  expect(acceptMention("line one\n@re", "@", "b.ts")).toBe("line one\n@b.ts ");
});

test("acceptMention: a TAB boundary preserves the draft prefix (the lastIndexOf-space bug)", () => {
  expect(acceptMention("before\t@re", "@", "c.ts")).toBe("before\t@c.ts ");
});

describe("slashTokenMatches", () => {
  test("a typo of the most-typed command never reaches an unrelated command", () => {
    // The reported P1: /hlep staged /plan-review, which writes workspace
    // settings with no confirmation.
    expect(slashTokenMatches(["/plan-review"], "hlep")).toBe(false);
    expect(slashTokenMatches(["/desktop-driver"], "servers")).toBe(false);
    expect(slashTokenMatches(["/compact"], "mcp")).toBe(false);
  });

  test("the token the user actually typed still matches, exactly and by prefix", () => {
    expect(slashTokenMatches(["/help"], "help")).toBe(true);
    expect(slashTokenMatches(["/help"], "hel")).toBe(true);
    expect(slashTokenMatches(["/plan-review"], "plan")).toBe(true);
    expect(slashTokenMatches(["/plan-review"], "planrev")).toBe(true);
    expect(slashTokenMatches(["/mcp"], "mcp")).toBe(true);
  });

  test("a leading slash in the typed term is tolerated", () => {
    expect(slashTokenMatches(["/help"], "/help")).toBe(true);
  });

  test("browsing with an empty term keeps every command listed", () => {
    expect(slashTokenMatches(["/anything"], "")).toBe(true);
    expect(slashTokenMatches(["/anything"], "   ")).toBe(true);
  });

  test("a command with several tokens matches on any of them", () => {
    expect(slashTokenMatches(["/quit", "/exit"], "exit")).toBe(true);
  });
});
