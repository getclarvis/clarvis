import { expect, test } from "bun:test";
import type { FieldEditor } from "../../src/views/config/view-host.tsx";
import { promptForApiKey } from "../../src/views/config/key-entry.ts";

function fakeFe(): { fe: FieldEditor; label: () => string; submit: (raw: string) => void } {
  let label = "";
  let captured: ((raw: string) => void) | undefined;
  const fe = {
    startSecret: (l: string, commit: (raw: string) => void) => {
      label = l;
      captured = commit;
    },
  } as unknown as FieldEditor;
  return {
    fe,
    label: () => label,
    submit: (raw) => captured!(raw),
  };
}

test("without a usageNote: the label is just 'API key -> envVar'", () => {
  const { fe, label } = fakeFe();
  promptForApiKey(fe, "OPENAI_API_KEY", { notify: () => {}, commit: () => {} });
  expect(label()).toContain("OPENAI_API_KEY");
  expect(label()).not.toContain("(");
});

test("with a usageNote: the label appends it in parens", () => {
  const { fe, label } = fakeFe();
  promptForApiKey(fe, "OPENAI_API_KEY", {
    notify: () => {},
    commit: () => {},
    usageNote: "used by the reviewer agent",
  });
  expect(label()).toContain("OPENAI_API_KEY");
  expect(label()).toContain("(used by the reviewer agent)");
});

test("an empty (or whitespace-only) submission notifies and leaves the key unchanged", () => {
  const { fe, submit } = fakeFe();
  const notes: string[] = [];
  const committed: string[] = [];
  promptForApiKey(fe, "OPENAI_API_KEY", {
    notify: (m) => notes.push(m),
    commit: (v) => committed.push(v),
  });
  submit("   ");
  expect(committed).toEqual([]);
  expect(notes).toEqual(["empty — key unchanged"]);
});

test("a non-empty submission is trimmed and committed, with no notify", () => {
  const { fe, submit } = fakeFe();
  const notes: string[] = [];
  const committed: string[] = [];
  promptForApiKey(fe, "OPENAI_API_KEY", {
    notify: (m) => notes.push(m),
    commit: (v) => committed.push(v),
  });
  submit("  sk-abc123  ");
  expect(committed).toEqual(["sk-abc123"]);
  expect(notes).toEqual([]);
});
