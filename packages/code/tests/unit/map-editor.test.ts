import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import {
  createMapEditor,
  formatMapValue,
  isMapNode,
  mapRows,
  parseMapValue,
  pruneEmpty,
  readAt,
  updateAt,
  type MapEditorSpec,
} from "../../src/ui/patterns/map-editor.tsx";

/** A recording stand-in for the three field-editor modals a map editor drives. */
function fakeEditor() {
  const opened: { mode: string; label: string; current?: string }[] = [];
  let pending: ((value: string) => void) | null = null;
  let manual: (() => void) | null = null;
  return {
    opened,
    /** Answers whatever modal is open; throws when nothing is. */
    answer(value: string): void {
      const commit = pending;
      if (!commit) throw new Error("no modal is open");
      pending = null;
      commit(value);
    },
    isOpen: (): boolean => pending !== null,
    start(label: string, current: string, commit: (v: string) => void) {
      opened.push({ mode: "text", label, current });
      pending = commit;
    },
    startMultiline(label: string, current: string, commit: (v: string) => void) {
      opened.push({ mode: "multiline", label, current });
      pending = commit;
    },
    startPick(
      label: string,
      items: { label: string; value: string; detail?: string }[],
      commit: (v: string) => void,
      opts?: { onManual?: () => void },
    ) {
      opened.push({ mode: "pick", label, current: items.map((i) => i.value).join(",") });
      manual = opts?.onManual ?? null;
      pending = commit;
    },
    /** Takes the picker's always-present manual-entry row. */
    chooseManual(): void {
      const fn = manual;
      if (!fn) throw new Error("the open picker offers no manual entry");
      manual = null;
      pending = null;
      fn();
    },
  };
}

/** A level stack whose depth a test drives directly, standing in for the host shell's escape. */
function fakeStack() {
  const [depth, setDepth] = createSignal(0);
  const pushed: string[] = [];
  return {
    pushed,
    depth,
    push: (title: string) => {
      pushed.push(title);
      setDepth((d) => d + 1);
    },
    /** What the host shell's escape does: decrement, nothing more. */
    escape: () => setDepth((d) => Math.max(0, d - 1)),
  };
}

/** Mounts a map editor over a signal-backed map, with the notices it emitted. */
function mount(initial: Record<string, unknown> | undefined, spec: Partial<MapEditorSpec> = {}) {
  return createRoot((dispose) => {
    const [map, setMap] = createSignal<Record<string, unknown> | undefined>(initial);
    const editor = fakeEditor();
    const stack = fakeStack();
    const notices: string[] = [];
    const maps = createMapEditor({
      editor,
      notify: (m) => notices.push(m),
      level: stack,
    });
    const open = (over: Partial<MapEditorSpec> = {}): void =>
      maps.open({
        label: "body",
        kind: "json",
        read: map,
        write: setMap,
        ...spec,
        ...over,
      });
    return { maps, map, editor, stack, notices, open, dispose };
  });
}

test("readAt/updateAt walk a nested map without mutating it", () => {
  const root = { provider: { order: ["a"], allow_fallbacks: false }, top_p: 0.9 };
  expect(readAt(root, [])).toEqual(root);
  expect(readAt(root, ["provider"])).toEqual({ order: ["a"], allow_fallbacks: false });

  const next = updateAt(root, ["provider"], (n) => {
    n.allow_fallbacks = true;
    return n;
  });
  expect(next.provider).toEqual({ order: ["a"], allow_fallbacks: true });
  expect(root.provider.allow_fallbacks).toBe(false);
  expect(next).not.toBe(root);
  expect(next.provider).not.toBe(root.provider);
});

test("pruneEmpty collapses a branch bottom-up, keeping every value that says something", () => {
  // Bottom-up matters: an inner object emptied first leaves its parent empty
  // too, and a single top-level pass would keep the parent and ship `{}`.
  expect(pruneEmpty({ provider: { max_price: {} }, seed: 1 })).toEqual({ seed: 1 });
  expect(pruneEmpty({ provider: { order: [] } })).toEqual({ provider: { order: [] } });
  // An empty ARRAY is a value — `order: []` means "no upstreams", not "unset".
  expect(pruneEmpty({ a: [], b: 0, c: false, d: "" })).toEqual({ a: [], b: 0, c: false, d: "" });
});

test("readAt treats a path through a scalar as empty rather than throwing", () => {
  expect(readAt({ top_p: 0.9 }, ["top_p", "deeper"])).toEqual({});
  expect(readAt(undefined, ["provider"])).toEqual({});
});

test("updateAt replaces a scalar standing where an object is written", () => {
  const next = updateAt({ provider: "openrouter" }, ["provider"], (n) => {
    n.order = ["a"];
    return n;
  });
  expect(next.provider).toEqual({ order: ["a"] });
});

test("an array is not a drillable node — its keys would be positions", () => {
  expect(isMapNode({ a: 1 })).toBe(true);
  expect(isMapNode(["a"])).toBe(false);
  expect(isMapNode(null)).toBe(false);
  expect(mapRows({ order: ["a", "b"] }, "json")[0]!.drills).toBe(false);
});

test("a json object is summarised by key count; a text value renders as itself", () => {
  expect(formatMapValue({ a: 1, b: 2 }, "json")).toBe("{ 2 keys }");
  expect(formatMapValue({ a: 1 }, "json")).toBe("{ 1 key }");
  expect(formatMapValue(["a"], "json")).toBe('["a"]');
  expect(formatMapValue(false, "json")).toBe("false");
  expect(formatMapValue("Bearer ${T}", "text")).toBe("Bearer ${T}");
  expect(formatMapValue(7, "text")).toBe("7");
});

test("opening pushes a level and projects the map into rows", () => {
  const { maps, open, stack, dispose } = mount({ top_p: 0.9, provider: { order: [] } });
  expect(maps.active()).toBe(false);
  open();
  expect(maps.active()).toBe(true);
  expect(stack.pushed).toEqual(["body"]);
  expect(maps.rows().map((r) => r.key)).toEqual(["top_p", "provider"]);
  expect(maps.rows()[1]!.drills).toBe(true);
  expect(maps.title()).toBe("body");
  dispose();
});

test("a suggestion's template value is staged verbatim, and a suggestion without one opens the editor", () => {
  const { maps, map, editor, open, dispose } = mount(undefined, {
    suggest: (path) =>
      path.length === 0
        ? [{ key: "provider", value: { order: [], allow_fallbacks: false } }, { key: "top_p" }]
        : [],
  });
  open();
  maps.levelSpec().verbs![0]!.run();
  expect(editor.opened.at(-1)!.mode).toBe("pick");
  editor.answer("provider");
  expect(map()).toEqual({ provider: { order: [], allow_fallbacks: false } });

  maps.levelSpec().verbs![0]!.run();
  editor.answer("top_p");
  expect(editor.opened.at(-1)!.mode).toBe("text");
  editor.answer("0.9");
  expect(map()).toEqual({ provider: { order: [], allow_fallbacks: false }, top_p: 0.9 });
  dispose();
});

test("the picker lists only what is not already set, and always offers manual entry", () => {
  const { maps, map, editor, open, dispose } = mount(
    { top_p: 0.9 },
    { suggest: () => [{ key: "top_p" }, { key: "seed" }] },
  );
  open();
  maps.levelSpec().verbs![0]!.run();
  expect(editor.opened.at(-1)!.current).toBe("seed");

  // Free entry is the picker's own manual row, not an item in the list: a list
  // long enough to grow a filter box hides every row the term does not match,
  // and typing an undocumented key is exactly when the escape is needed.
  editor.chooseManual();
  expect(editor.opened.at(-1)!.mode).toBe("text");
  editor.answer("service_tier");
  editor.answer("flex");
  expect(map()).toEqual({ top_p: 0.9, service_tier: "flex" });
  dispose();
});

test("with no suggestions [a] goes straight to free key entry", () => {
  const { maps, map, editor, open, dispose } = mount(undefined);
  open();
  maps.levelSpec().verbs![0]!.run();
  expect(editor.opened.at(-1)!.mode).toBe("text");
  editor.answer("seed");
  editor.answer("42");
  expect(map()).toEqual({ seed: 42 });
  dispose();
});

test("a duplicate key is refused with a notice and writes nothing", () => {
  const { maps, map, editor, notices, open, dispose } = mount({ seed: 1 });
  open();
  maps.levelSpec().verbs![0]!.run();
  editor.answer("seed");
  expect(notices.at(-1)).toContain("already set");
  expect(map()).toEqual({ seed: 1 });
  dispose();
});

test("rejectKey refuses a forbidden key at the root and lets it through when nested", () => {
  const { maps, map, editor, notices, open, dispose } = mount(
    { provider: {} },
    { rejectKey: (key, path) => (path.length === 0 && key === "messages" ? "refused" : undefined) },
  );
  open();
  maps.levelSpec().verbs![0]!.run();
  editor.answer("messages");
  expect(notices.at(-1)).toBe("refused");
  expect(map()).toEqual({ provider: {} });

  maps.levelSpec().nav!.setIndex(0);
  maps.levelSpec().nav!.activate!.run();
  expect(maps.path()).toEqual(["provider"]);
  maps.levelSpec().verbs![0]!.run();
  editor.answer("messages");
  editor.answer('"kept"');
  expect(map()).toEqual({ provider: { messages: "kept" } });
  dispose();
});

test("parseMapValue reads JSON first, and bare text only when there is no JSON punctuation", () => {
  expect(parseMapValue("42")).toEqual({ ok: true, value: 42 });
  expect(parseMapValue("false")).toEqual({ ok: true, value: false });
  expect(parseMapValue('["a"]')).toEqual({ ok: true, value: ["a"] });
  expect(parseMapValue('"throughput"')).toEqual({ ok: true, value: "throughput" });

  // The convenience: an enumerated string field is the commonest scalar edit,
  // and making the user quote it turns it into a JSON quiz.
  expect(parseMapValue("throughput")).toEqual({ ok: true, value: "throughput" });
  expect(parseMapValue("middle-out")).toEqual({ ok: true, value: "middle-out" });

  // And its bound: anything half-written still fails loudly, because there a
  // silent reinterpretation would be a data bug rather than a convenience.
  for (const bad of ['["a', "{x: 1", '{"a": }', 'say "hi"']) {
    const r = parseMapValue(bad);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("not valid JSON");
  }
});

test("unparsable JSON notifies and leaves the map untouched", () => {
  const { maps, map, editor, notices, open, dispose } = mount({ seed: 1 });
  open();
  maps.levelSpec().nav!.activate!.run();
  editor.answer('{"a": }');
  expect(notices.at(-1)).toContain("not valid JSON");
  expect(map()).toEqual({ seed: 1 });
  dispose();
});

test("a bare enumerated string lands as a string, and re-opens quoted so it round-trips", () => {
  const { maps, map, editor, open, dispose } = mount({ provider: {} });
  open();
  maps.levelSpec().nav!.activate!.run();
  maps.levelSpec().verbs![0]!.run();
  editor.answer("sort");
  editor.answer("throughput");
  expect(map()).toEqual({ provider: { sort: "throughput" } });

  maps.levelSpec().nav!.activate!.run();
  expect(editor.opened.at(-1)!.current).toBe('"throughput"');
  dispose();
});

test("an emptied JSON value is refused, and points at the verb that removes the key", () => {
  const { maps, map, editor, notices, open, dispose } = mount({ seed: 1 });
  open();
  maps.levelSpec().nav!.activate!.run();
  editor.answer("   ");
  expect(notices.at(-1)).toContain("needs a value");
  expect(map()).toEqual({ seed: 1 });
  dispose();
});

test("rejectValue guards a text map's values", () => {
  const { maps, map, editor, notices, open, dispose } = mount(
    { "X-Title": "clarvis" },
    {
      label: "headers",
      kind: "text",
      rejectValue: (v) => (String(v).includes("${TOKEN") ? "malformed" : undefined),
    },
  );
  open();
  maps.levelSpec().nav!.activate!.run();
  expect(editor.opened.at(-1)!.current).toBe("clarvis");
  editor.answer("Bearer ${TOKEN");
  expect(notices.at(-1)).toBe("malformed");
  expect(map()).toEqual({ "X-Title": "clarvis" });
  dispose();
});

test("a structured value gets the textarea and a scalar gets the one-line input", () => {
  const { maps, editor, open, dispose } = mount({ provider: { order: [] }, order: [], seed: 1 });
  open();
  maps.levelSpec().nav!.setIndex(1);
  maps.levelSpec().nav!.activate!.run();
  expect(editor.opened.at(-1)!.mode).toBe("multiline");
  editor.answer("[]");

  maps.levelSpec().nav!.setIndex(2);
  maps.levelSpec().nav!.activate!.run();
  expect(editor.opened.at(-1)!.mode).toBe("text");
  expect(editor.opened.at(-1)!.current).toBe("1");
  dispose();
});

test("drilling shows the nested object and writes back through the whole path", () => {
  const { maps, map, editor, stack, open, dispose } = mount({
    provider: { order: ["deepseek"], allow_fallbacks: true },
  });
  open();
  maps.levelSpec().nav!.activate!.run();
  expect(maps.path()).toEqual(["provider"]);
  expect(stack.pushed).toEqual(["body", "provider"]);
  expect(maps.rows().map((r) => r.key)).toEqual(["order", "allow_fallbacks"]);
  expect(maps.title()).toBe("body.provider");

  maps.levelSpec().nav!.setIndex(1);
  maps.levelSpec().nav!.activate!.run();
  editor.answer("false");
  expect(map()).toEqual({ provider: { order: ["deepseek"], allow_fallbacks: false } });
  dispose();
});

test("escaping pops one path segment, and escaping past the base closes the editor", () => {
  const { maps, stack, open, dispose } = mount({ provider: { order: [] } });
  open();
  maps.levelSpec().nav!.activate!.run();
  expect(maps.path()).toEqual(["provider"]);

  stack.escape();
  expect(maps.path()).toEqual([]);
  expect(maps.active()).toBe(true);

  stack.escape();
  expect(maps.active()).toBe(false);
  expect(maps.rows()).toEqual([]);
  dispose();
});

test("removing the last entry writes undefined, so the enclosing key is dropped", () => {
  const { maps, map, open, dispose } = mount({ seed: 1 });
  open();
  maps.levelSpec().verbs![2]!.run();
  expect(map()).toBeUndefined();
  dispose();
});

test("removing the last entry of a nested object removes the object too", () => {
  // `{}` is not the same value as an absent key on the wire: a router reads
  // `"provider": {}` as a routing block it must honour. Leaving it behind meant
  // emptying `body.provider` staged and SAVED an object that says nothing, and
  // every assertion about the remaining keys stayed green while it did.
  const { maps, map, open, dispose } = mount({ provider: { order: [] }, seed: 1 });
  open();
  maps.levelSpec().nav!.activate!.run();
  maps.levelSpec().verbs![2]!.run();
  expect(map()).toEqual({ seed: 1 });
  dispose();
});

test("rename keeps the entry in place rather than moving it to the end", () => {
  const { maps, map, editor, open, dispose } = mount({ a: 1, b: 2, c: 3 });
  open();
  maps.levelSpec().nav!.setIndex(1);
  maps.levelSpec().verbs![1]!.run();
  editor.answer("bee");
  expect(Object.keys(map()!)).toEqual(["a", "bee", "c"]);
  expect(map()!.bee).toBe(2);
  dispose();
});

test("rename onto an existing key is refused", () => {
  const { maps, map, editor, notices, open, dispose } = mount({ a: 1, b: 2 });
  open();
  maps.levelSpec().verbs![1]!.run();
  editor.answer("b");
  expect(notices.at(-1)).toContain("already set");
  expect(map()).toEqual({ a: 1, b: 2 });
  dispose();
});

test("rename and remove are hidden on an empty map, add is not", () => {
  const { maps, open, dispose } = mount(undefined);
  open();
  const verbs = maps.levelSpec().verbs!;
  expect(verbs[0]!.when?.()).toBeUndefined();
  expect(verbs[1]!.when!()).toBe(false);
  expect(verbs[2]!.when!()).toBe(false);
  dispose();
});

test("an object staged from a suggestion survives until the editor closes, then is pruned", () => {
  // The three suggestions whose template is `{}` — reasoning, logit_bias,
  // max_price — exist so the row can be drilled into, so pruning on every write
  // would make them unusable. Pruning only on the two edges where an empty
  // object can only be leftover keeps both halves true.
  const { maps, map, editor, open, stack, dispose } = mount(
    { seed: 1 },
    { suggest: () => [{ key: "reasoning", value: {} }] },
  );
  open();
  maps.levelSpec().verbs![0]!.run();
  editor.answer("reasoning");
  expect(map()).toEqual({ seed: 1, reasoning: {} });
  stack.escape();
  expect(map()).toEqual({ seed: 1 });
  dispose();
});

test("visiting a map and leaving it writes nothing back", () => {
  // Closing the editor persists the pruned map unconditionally, so opening an
  // empty one and pressing Escape marked the config `Unsaved` and later demanded
  // a discard confirmation for bytes verified byte-identical.
  const writes: (Record<string, unknown> | undefined)[] = [];
  const h = createRoot((dispose) => {
    const [map, setMap] = createSignal<Record<string, unknown> | undefined>(undefined);
    const editor = fakeEditor();
    const stack = fakeStack();
    const maps = createMapEditor({ editor, notify: () => {}, level: stack });
    maps.open({
      label: "headers",
      kind: "text",
      read: map,
      write: (next) => {
        writes.push(next);
        setMap(next);
      },
    });
    return { stack, dispose };
  });
  h.stack.escape();
  expect(writes).toEqual([]);
  h.dispose();
});

test("re-entering an unchanged populated map also writes nothing back", () => {
  const writes: (Record<string, unknown> | undefined)[] = [];
  const h = createRoot((dispose) => {
    const [map, setMap] = createSignal<Record<string, unknown> | undefined>({ "X-Key": "v" });
    const editor = fakeEditor();
    const stack = fakeStack();
    const maps = createMapEditor({ editor, notify: () => {}, level: stack });
    maps.open({
      label: "headers",
      kind: "text",
      read: map,
      write: (next) => {
        writes.push(next);
        setMap(next);
      },
    });
    return { stack, dispose };
  });
  h.stack.escape();
  expect(writes).toEqual([]);
  h.dispose();
});
