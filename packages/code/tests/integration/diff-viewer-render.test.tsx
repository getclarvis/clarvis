import { expect, test } from "bun:test";
import { openRender, settleSyntaxSurfaces } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { DiffViewer, projectChangeFiles } from "../../src/views/overlays/DiffViewer.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import type { WorkspaceChangeEntry, WorkspaceChangesService } from "@clarvis/protocol";

const REAL_DIFF = [
  "--- a.ts",
  "+++ a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
].join("\n");

function fakeInteraction(): {
  interaction: Interaction;
} {
  const { keymap } = createFakeKeymap();
  return { interaction: { keymap } as unknown as Interaction };
}

function fakeChanges(
  items: WorkspaceChangeEntry[],
  patches: Record<string, string> = {},
  availability: "available" | "not_applicable" | "unavailable" = "available",
  details: Record<string, "binary" | "conflict" | "truncated" | "stale"> = {},
): WorkspaceChangesService {
  return {
    availability: async () =>
      availability === "available"
        ? {
            status: "available",
            provider: {
              id: "fake",
              name: "Fake",
              workspace_identity: "workspace",
              default_comparison_id: "all",
              comparisons: [
                { id: "all", label: "All", description: "all changes" },
                { id: "other", label: "Other", description: "another view" },
              ],
              capabilities: { staging: false, renames: true, conflicts: false },
            },
          }
        : {
            status: availability,
            reason: { code: "not_a_repository", message: "this workspace is not a Git repository" },
          },
    list: async () => ({
      query_id: "q1",
      comparison_id: "all",
      resolved_base: "HEAD",
      incomplete: false,
      items,
    }),
    read: async (request) => {
      const special = details[request.entry_id];
      if (special !== undefined) {
        return {
          entry_id: request.entry_id,
          query_id: request.query_id,
          comparison_id: "all",
          resolved_base: "HEAD",
          status: special,
          message:
            special === "binary"
              ? "binary file"
              : special === "conflict"
                ? "unmerged path"
                : special === "truncated"
                  ? "patch exceeds the admitted size"
                  : "change is stale; refresh",
        };
      }
      return {
        entry_id: request.entry_id,
        query_id: request.query_id,
        comparison_id: "all",
        resolved_base: "HEAD",
        status: "ready",
        patch: patches[request.entry_id] ?? REAL_DIFF,
      };
    },
  };
}

async function frame(service: WorkspaceChangesService | undefined): Promise<string> {
  const { interaction } = fakeInteraction();
  const t = await openRender(
    (() => (
      <DiffViewer interaction={interaction} service={() => service} onClose={() => undefined} />
    )) as never,
    { width: 100, height: 40 },
  );
  await settleSyntaxSurfaces(t);
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("unavailable provider shows a short explanation, not a clean tree", async () => {
  const out = await frame(fakeChanges([], {}, "not_applicable"));
  expect(out).toContain("Diff");
  expect(out).toContain("this workspace is not a Git repository");
  expect(out).not.toContain("Change 1");
});

test("an empty comparison shows no changes", async () => {
  const out = await frame(fakeChanges([]));
  expect(out).toContain("no workspace changes yet");
  expect(out).toContain("working tree matches the selected comparison");
});

test("a fake provider without Git concepts still lists and renders a patch", async () => {
  const out = await frame(
    fakeChanges(
      [{ id: "a", new_path: "a.ts", operation: "modified", stats: { additions: 1, deletions: 1 } }],
      {
        a: REAL_DIFF,
      },
    ),
  );
  expect(out).toContain("TWO");
  expect(out).toContain("two");
  expect(out).toContain("a.ts");
  expect(out).not.toContain("Change 1");
});

test("the changed-file tree expands folders and selects one complete file diff", async () => {
  const { keymap, press } = createFakeKeymap();
  const interaction = { keymap } as unknown as Interaction;
  const service = fakeChanges(
    [
      { id: "first", new_path: "src/first.ts", operation: "modified" },
      { id: "second", new_path: "src/second.ts", operation: "modified" },
    ],
    {
      first: "--- src/first.ts\n+++ src/first.ts\n@@ -1 +1 @@\n-old first\n+new first",
      second: "--- src/second.ts\n+++ src/second.ts\n@@ -1 +1 @@\n-old second\n+new second",
    },
  );
  const t = await openRender(
    (() => (
      <DiffViewer interaction={interaction} service={() => service} onClose={() => undefined} />
    )) as never,
    { width: 100, height: 40 },
  );
  await settleSyntaxSurfaces(t);
  let out = t.captureCharFrame();
  expect(out).toContain("2 files");
  expect(out).toContain("src/first.ts");
  expect(out).toContain("new first");
  expect(out).toContain("second.ts");
  expect(out).not.toContain("new second");
  press("down");
  press("down");
  press("return");
  await settleSyntaxSurfaces(t);
  out = t.captureCharFrame();
  expect(out).toContain("src/second.ts");
  expect(out).toContain("new second");
  expect(out).not.toContain("new first");
  t.renderer.destroy();
});

test("binary, conflict and truncated details render as hints", async () => {
  const out = await frame(
    fakeChanges(
      [
        { id: "bin", new_path: "logo.png", operation: "added", binary: true },
        { id: "conflict", new_path: "merge.ts", operation: "conflict" },
      ],
      {},
      "available",
      { bin: "binary" },
    ),
  );
  expect(out).toContain("binary file");
  expect(out).toContain("logo.png");
  expect(out).not.toContain("Change 1");
});

test("inventory identity is the structured path, not a Change N label", () => {
  expect(
    projectChangeFiles([
      { id: "a", new_path: "src/a.ts", operation: "modified" },
      { id: "b", old_path: "gone.ts", operation: "deleted" },
    ]).map((file) => file.path),
  ).toEqual(["gone.ts", "src/a.ts"]);
});

test("a deep name stays whole in the single-pane tree instead of being abbreviated", async () => {
  const name = "a-very-long-file-name-that-must-not-be-abbreviated.test.ts";
  const { interaction } = fakeInteraction();
  const service = fakeChanges([
    {
      id: "deep",
      new_path: `packages/kernel/tests/integration/${name}`,
      operation: "modified",
      stats: { additions: 67, deletions: 2 },
    },
  ]);
  const t = await openRender(
    (() => (
      <DiffViewer interaction={interaction} service={() => service} onClose={() => undefined} />
    )) as never,
    // Narrower than the split threshold: the tree is the whole frame, so the
    // selection's identity block is the only place the file is named.
    { width: 60, height: 30 },
  );
  await t.renderOnce();
  const out = t.captureCharFrame();
  const joined = out
    .split("\n")
    .map((line) => line.trim())
    .join("");
  expect(joined).toContain(name);
  expect(out).toContain("packages/kernel/tests/integration/");
  expect(out).toContain("Modified");
  expect(out).toContain("+67");
  expect(out).not.toContain("…");
  t.renderer.destroy();
});

test("moving the tree selection identifies it without loading its patch", async () => {
  const { keymap, press } = createFakeKeymap();
  const interaction = { keymap } as unknown as Interaction;
  const service = fakeChanges(
    [
      { id: "first", new_path: "src/first.ts", operation: "modified", stats: { additions: 2 } },
      { id: "second", new_path: "src/second.ts", operation: "added", stats: { additions: 9 } },
    ],
    {
      first: "--- src/first.ts\n+++ src/first.ts\n@@ -1 +1 @@\n-old first\n+new first",
      second: "--- src/second.ts\n+++ src/second.ts\n@@ -1 +1 @@\n-old second\n+new second",
    },
  );
  const t = await openRender(
    (() => (
      <DiffViewer interaction={interaction} service={() => service} onClose={() => undefined} />
    )) as never,
    { width: 100, height: 40 },
  );
  await settleSyntaxSurfaces(t);
  // At rest the cursor is on the file the detail pane has open, so the pane header
  // names it and the tree does not repeat the identity.
  const atRest = t.captureCharFrame();
  expect(atRest).toContain("src/first.ts");
  expect(atRest).not.toContain("Selected");
  press("down");
  press("down");
  await t.renderOnce();
  const moved = t.captureCharFrame();
  // The cursor's file is identified as a selection while the open patch keeps its
  // own header: moving the cursor reads nothing.
  expect(moved).toContain("Selected");
  expect(moved).toContain("second.ts");
  expect(moved).toContain("Added");
  expect(moved).toContain("+9");
  expect(moved).toContain("new first");
  expect(moved).not.toContain("new second");
  t.renderer.destroy();
});

test("a narrow terminal opens file detail as a separate step and Escape returns to the tree", async () => {
  const { keymap, press } = createFakeKeymap();
  const interaction = { keymap } as unknown as Interaction;
  const service = fakeChanges(
    [{ id: "narrow", new_path: "src/narrow.ts", operation: "modified" }],
    { narrow: "--- src/narrow.ts\n+++ src/narrow.ts\n@@ -1 +1 @@\n-old\n+NARROW DETAIL" },
  );
  const t = await openRender(
    (() => (
      <DiffViewer interaction={interaction} service={() => service} onClose={() => undefined} />
    )) as never,
    { width: 60, height: 24 },
  );
  await t.renderOnce();
  for (let i = 0; i < 8; i++) await t.renderOnce();
  let out = t.captureCharFrame();
  expect(out).toContain("Changed files");
  expect(out).not.toContain("NARROW DETAIL");
  press("down");
  press("return");
  await settleSyntaxSurfaces(t);
  out = t.captureCharFrame();
  expect(out).not.toContain("Changed files");
  expect(out).toContain("NARROW DETAIL");
  press("escape");
  await t.renderOnce();
  out = t.captureCharFrame();
  expect(out).toContain("Changed files");
  expect(out).not.toContain("NARROW DETAIL");
  t.renderer.destroy();
});
