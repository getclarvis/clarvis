import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadWorkflow, loadWorkflows, WORKFLOW_FILE } from "@clarvis/workflows/artifact";
import { WORKFLOW_LIMITS } from "../../src/limits.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Write a workflow directory under a fresh root and return both paths. */
function write(
  name: string,
  document: string,
  briefs: Record<string, string> = { "briefs/one.md": "Do the thing." },
): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "clarvis-workflows-"));
  roots.push(root);
  const dir = join(root, name);
  mkdirSync(join(dir, "briefs"), { recursive: true });
  writeFileSync(join(dir, WORKFLOW_FILE), document);
  for (const [path, body] of Object.entries(briefs)) writeFileSync(join(dir, path), body);
  return { root, dir };
}

const MINIMAL = `---
name: probe
description: A one-round workflow.
rounds:
  - id: look
    title: Look around
    type: discovery
    over: once
    brief: briefs/one.md
---

# Synthesis

Say what was found.
`;

describe("loadWorkflow", () => {
  test("loads frontmatter, resolves the selector and reads the brief off disk", () => {
    const { dir } = write("probe", MINIMAL);
    const workflow = loadWorkflow(dir);
    expect(workflow.name).toBe("probe");
    expect(workflow.description).toBe("A one-round workflow.");
    expect(workflow.rounds).toHaveLength(1);
    expect(workflow.rounds[0]?.over).toEqual({ kind: "once" });
    expect(workflow.rounds[0]?.brief).toBe("Do the thing.");
    expect(workflow.rounds[0]?.fanout).toBe(1);
    expect(workflow.synthesis).toContain("Say what was found.");
    expect(workflow.args).toEqual([]);
  });

  test("compiles the compact selector, accept and repeat forms", () => {
    const { dir } = write(
      "probe",
      `---
name: probe
description: Multi-round.
args: [subject]
rounds:
  - id: look
    title: Look around
    type: discovery
    over: once
    brief: briefs/one.md
  - id: judge
    title: Judge {{item.title}}
    type: verdict
    profile: explorer
    over: each(look.work_items where mutation)
    fanout: 3
    accept: threshold(verdict, refuted, 2)
    when: look.work_items
    brief: briefs/two.md
repeat:
  rounds: [judge]
  dedupe_by: [claim]
  max_rounds: 2
---
body`,
      { "briefs/one.md": "Map {{args.subject}}.", "briefs/two.md": "Judge {{item.id}}." },
    );
    const workflow = loadWorkflow(dir);
    expect(workflow.rounds[1]?.over).toEqual({
      kind: "each",
      source: "look.work_items",
      where: { field: "mutation" },
    });
    expect(workflow.rounds[1]?.accept).toEqual({
      kind: "threshold",
      field: "verdict",
      value: "refuted",
      count: 2,
    });
    expect(workflow.rounds[1]?.fanout).toBe(3);
    expect(workflow.rounds[1]?.profile).toBe("explorer");
    expect(workflow.rounds[1]?.when).toBe("look.work_items");
    expect(workflow.repeat).toEqual({
      rounds: ["judge"],
      until: "no_new",
      dedupe_by: ["claim"],
      max_rounds: 2,
    });
  });

  test("a name that disagrees with its directory is an error, not a warning", () => {
    const { dir } = write("elsewhere", MINIMAL);
    expect(() => loadWorkflow(dir)).toThrow(/does not match its directory/u);
  });

  test("rejects a multiline round title instead of deriving a label from it", () => {
    const { dir } = write(
      "probe",
      MINIMAL.replace("title: Look around", 'title: "Look around\\nthen report"'),
    );
    expect(() => loadWorkflow(dir)).toThrow(/title must fit on one line/u);
  });

  test.each([
    ["no frontmatter fence", "just prose", /frontmatter/u],
    ["a missing name", "---\ndescription: d\nrounds: []\n---\n", /name/u],
    ["a name with a path separator", "---\nname: a/b\ndescription: d\nrounds: []\n---\n", /name/u],
    ["no description", "---\nname: probe\nrounds: []\n---\n", /description/u],
    ["no rounds", "---\nname: probe\ndescription: d\nrounds: []\n---\n", /at least one round/u],
    [
      "an unknown round type",
      "---\nname: probe\ndescription: d\nrounds:\n  - id: a\n    title: Probe\n    type: guess\n    over: once\n    brief: briefs/one.md\n---\n",
      /type/u,
    ],
  ])("rejects %s", (_label, document, pattern) => {
    const { dir } = write("probe", document);
    expect(() => loadWorkflow(dir)).toThrow(pattern);
  });

  test("rejects a selector, an accept rule or a repeat target it cannot compile", () => {
    const bad = (round: string, extra = ""): string =>
      `---\nname: probe\ndescription: d\nrounds:\n  - id: a\n    title: Probe\n    type: free\n    over: once\n    brief: briefs/one.md\n${round}\n---\n${extra}`;
    expect(() =>
      loadWorkflow(
        write(
          "probe",
          bad(
            "  - id: b\n    title: Probe again\n    type: free\n    over: sometimes(a.x)\n    brief: briefs/one.md",
          ),
        ).dir,
      ),
    ).toThrow(/is not a selector/u);
    expect(() =>
      loadWorkflow(
        write(
          "probe",
          bad(
            "  - id: b\n    title: Probe again\n    type: free\n    over: each(a.x)\n    accept: vibes(v, r)\n    brief: briefs/one.md",
          ),
        ).dir,
      ),
    ).toThrow(/is not an accept rule/u);
    expect(() =>
      loadWorkflow(
        write("probe", bad("repeat:\n  rounds: [ghost]\n  dedupe_by: [c]\n  max_rounds: 2")).dir,
      ),
    ).toThrow(/unknown round 'ghost'/u);
  });

  test("rejects a duplicated round id", () => {
    const { dir } = write(
      "probe",
      "---\nname: probe\ndescription: d\nrounds:\n  - id: a\n    title: Probe\n    type: free\n    over: once\n    brief: briefs/one.md\n  - id: a\n    title: Probe again\n    type: free\n    over: once\n    brief: briefs/one.md\n---\n",
    );
    expect(() => loadWorkflow(dir)).toThrow(/share the id/u);
  });

  test.each([
    [
      "fanout above the hard ceiling",
      `  - id: a\n    title: Probe\n    type: free\n    over: once\n    fanout: ${String(WORKFLOW_LIMITS.fanout + 1)}\n    brief: briefs/one.md`,
      /fanout/u,
    ],
    [
      "repeat max_rounds above the hard ceiling",
      `  - id: a\n    title: Probe\n    type: free\n    over: once\n    brief: briefs/one.md\nrepeat:\n  rounds: [a]\n  dedupe_by: [id]\n  max_rounds: ${String(WORKFLOW_LIMITS.repeatMaxRounds + 1)}`,
      /max_rounds/u,
    ],
    [
      "more rounds than the hard ceiling",
      Array.from(
        { length: WORKFLOW_LIMITS.rounds + 1 },
        (_, index) =>
          `  - id: r${String(index)}\n    title: Probe ${String(index)}\n    type: free\n    over: once\n    brief: briefs/one.md`,
      ).join("\n"),
      /rounds/u,
    ],
  ])("rejects %s during artifact validation", (_label, rounds, pattern) => {
    const { dir } = write(
      "probe",
      `---\nname: probe\ndescription: d\nrounds:\n${rounds}\n---\nbody`,
    );
    expect(() => loadWorkflow(dir)).toThrow(pattern);
  });

  test("rejects an oversized brief before reading its body", () => {
    const { dir } = write("probe", MINIMAL, {
      "briefs/one.md": "x".repeat(WORKFLOW_LIMITS.briefBytes + 1),
    });
    expect(() => loadWorkflow(dir)).toThrow(/byte limit/u);
  });

  test("rejects a brief whose decoded text exceeds the character ceiling", () => {
    const { dir } = write("probe", MINIMAL, {
      "briefs/one.md": "x".repeat(WORKFLOW_LIMITS.textChars + 1),
    });
    expect(() => loadWorkflow(dir)).toThrow(/character limit/u);
  });

  test("rejects an oversized workflow document before parsing it", () => {
    const { dir } = write("probe", "x".repeat(WORKFLOW_LIMITS.artifactBytes + 1));
    expect(() => loadWorkflow(dir)).toThrow(/byte limit/u);
  });

  test("rejects an oversized synthesis even when its byte-sized artifact is admitted", () => {
    const { dir } = write(
      "probe",
      MINIMAL.replace("Say what was found.", "x".repeat(WORKFLOW_LIMITS.textChars + 1)),
    );
    expect(() => loadWorkflow(dir)).toThrow(/synthesis.*character limit/u);
  });

  test("rejects a first round that consumes something, since nothing has run", () => {
    const { dir } = write(
      "probe",
      "---\nname: probe\ndescription: d\nrounds:\n  - id: a\n    title: Probe\n    type: free\n    over: all(b.x)\n    brief: briefs/one.md\n---\n",
    );
    expect(() => loadWorkflow(dir)).toThrow(/must be 'once'/u);
  });

  test("rejects a brief that escapes the workflow directory, or that is missing", () => {
    const { dir } = write(
      "probe",
      "---\nname: probe\ndescription: d\nrounds:\n  - id: a\n    title: Probe\n    type: free\n    over: once\n    brief: ../../etc/passwd\n---\n",
    );
    expect(() => loadWorkflow(dir)).toThrow(/inside the workflow/u);
    const gone = write(
      "probe",
      "---\nname: probe\ndescription: d\nrounds:\n  - id: a\n    title: Probe\n    type: free\n    over: once\n    brief: briefs/absent.md\n---\n",
    );
    expect(() => loadWorkflow(gone.dir)).toThrow(/could not be read/u);
  });

  test("rejects a brief referencing an arg the workflow never declared", () => {
    const { dir } = write("probe", MINIMAL, { "briefs/one.md": "Audit {{args.subject}}." });
    expect(() => loadWorkflow(dir)).toThrow(/not a declared arg/u);
  });

  test("accepts a brief referencing item and state, which are only known at run time", () => {
    const { dir } = write("probe", MINIMAL, {
      "briefs/one.md": "Look at {{item.goal}} given {{state.other.scope}}.",
    });
    expect(loadWorkflow(dir).rounds[0]?.brief).toContain("{{item.goal}}");
  });
});

describe("loadWorkflows", () => {
  test("collects a malformed workflow as an error instead of hiding the others", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-workflows-"));
    roots.push(root);
    for (const name of ["good", "bad"]) {
      mkdirSync(join(root, name, "briefs"), { recursive: true });
      writeFileSync(join(root, name, "briefs", "one.md"), "Do it.");
    }
    writeFileSync(join(root, "good", WORKFLOW_FILE), MINIMAL.replace("probe", "good"));
    writeFileSync(join(root, "bad", WORKFLOW_FILE), "not a workflow");

    const registry = loadWorkflows([root]);
    expect(registry.workflows.map((w) => w.name)).toEqual(["good"]);
    expect(registry.errors).toHaveLength(1);
    expect(registry.errors[0]?.message).toContain("frontmatter");
  });

  test("a later root overrides an earlier one of the same name", () => {
    const first = write("probe", MINIMAL);
    const second = write("probe", MINIMAL.replace("A one-round workflow.", "The override."));
    const registry = loadWorkflows([first.root, second.root]);
    expect(registry.workflows).toHaveLength(1);
    expect(registry.workflows[0]?.description).toBe("The override.");
  });

  test("a root that does not exist contributes nothing rather than throwing", () => {
    expect(loadWorkflows([join(tmpdir(), "clarvis-absent-root")])).toEqual({
      workflows: [],
      errors: [],
    });
  });

  test("a catalogue root that is a file contributes nothing, and says so", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-workflows-"));
    roots.push(root);
    const file = join(root, "not-a-directory");
    writeFileSync(file, "not a catalogue");

    const registry = loadWorkflows([file]);
    expect(registry.workflows).toEqual([]);
    // An unreadable root used to yield zero workflows and zero diagnostics, so
    // `run_workflow` vanished from the tool list with nothing saying why.
    expect(registry.errors).toHaveLength(1);
    expect(registry.errors[0]?.dir).toBe(file);
    expect(registry.errors[0]?.message).toContain("workflow root is unreadable");
  });

  test("workflows come back sorted by name, so a catalogue is stable", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-workflows-"));
    roots.push(root);
    for (const name of ["zebra", "alpha"]) {
      mkdirSync(join(root, name, "briefs"), { recursive: true });
      writeFileSync(join(root, name, "briefs", "one.md"), "Do it.");
      writeFileSync(join(root, name, WORKFLOW_FILE), MINIMAL.replaceAll("probe", name));
    }
    expect(loadWorkflows([root]).workflows.map((w) => w.name)).toEqual(["alpha", "zebra"]);
  });

  test("rejects too many workflow directories atomically", () => {
    const good = write("probe", MINIMAL);
    const crowded = mkdtempSync(join(tmpdir(), "clarvis-workflows-"));
    roots.push(crowded);
    for (let index = 0; index < WORKFLOW_LIMITS.catalogWorkflows; index += 1) {
      mkdirSync(join(crowded, `workflow-${String(index).padStart(3, "0")}`));
    }

    const registry = loadWorkflows([good.root, crowded]);
    expect(registry.workflows).toEqual([]);
    expect(registry.errors).toHaveLength(1);
    expect(registry.errors[0]?.message).toContain("workflow catalogue resource limit");
    expect(registry.errors[0]?.message).toContain("workflow directories");
  });

  test("stops an entry flood without materializing the directory", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-workflows-"));
    roots.push(root);
    for (let index = 0; index <= WORKFLOW_LIMITS.catalogEntries; index += 1) {
      writeFileSync(join(root, `noise-${String(index).padStart(4, "0")}`), "");
    }

    const registry = loadWorkflows([root]);
    expect(registry.workflows).toEqual([]);
    expect(registry.errors).toHaveLength(1);
    expect(registry.errors[0]?.message).toContain("directory entries");
  });

  test("rejects excessive aggregate source bytes atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-workflows-"));
    roots.push(root);
    const document = Buffer.alloc(WORKFLOW_LIMITS.artifactBytes);
    const count = Math.floor(WORKFLOW_LIMITS.catalogSourceBytes / document.byteLength) + 1;
    for (let index = 0; index < count; index += 1) {
      const dir = join(root, `workflow-${String(index).padStart(3, "0")}`);
      mkdirSync(dir);
      writeFileSync(join(dir, WORKFLOW_FILE), document);
    }

    const registry = loadWorkflows([root]);
    expect(registry.workflows).toEqual([]);
    expect(registry.errors).toHaveLength(1);
    expect(registry.errors[0]?.message).toContain("aggregate bytes");
  });

  test("rejects an excessive root list without touching the filesystem", () => {
    const registry = loadWorkflows(
      Array.from(
        { length: WORKFLOW_LIMITS.catalogRoots + 1 },
        (_, index) => `/absent/workflows-${String(index)}`,
      ),
    );
    expect(registry.workflows).toEqual([]);
    expect(registry.errors).toHaveLength(1);
    expect(registry.errors[0]?.message).toContain("roots");
  });
});

describe("brief path containment", () => {
  test.each([
    ["a POSIX absolute path", "/etc/passwd"],
    ["a parent traversal", "../../etc/passwd"],
    ["a Windows drive path", "C:\\secrets\\x.md"],
    ["a UNC path", "\\\\host\\share\\x.md"],
    ["the workflow directory itself", "."],
  ])("refuses %s", (_label, brief) => {
    const { dir } = write(
      "probe",
      `---\nname: probe\ndescription: d\nrounds:\n  - id: a\n    title: Probe\n    type: free\n    over: once\n    brief: "${brief.replaceAll("\\", "\\\\")}"\n---\n`,
    );
    // `startsWith("/")` misses both Windows forms, and join() would resolve them
    // to an absolute target there.
    expect(() => loadWorkflow(dir)).toThrow(/inside the workflow|could not be read/u);
  });

  test("accepts an ordinary nested brief", () => {
    const { dir } = write("probe", MINIMAL, { "briefs/one.md": "Fine." });
    expect(loadWorkflow(dir).rounds[0]?.brief).toBe("Fine.");
  });
});
