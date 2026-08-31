import { expect, test } from "bun:test";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { openRender, settleSyntaxSurfaces } from "../helpers/tracked-render.ts";
import { createMutable } from "solid-js/store";
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { OverlayRegion } from "../../src/views/app/OverlayRegion.tsx";
import { createOverlayHost, type OverlayHost } from "../../src/views/overlay-host.ts";
import type { OverlayKind, Interaction } from "../../src/keys/interaction.ts";
import type { ViewHost } from "../../src/keys/commands.ts";
import type { ActivityStore } from "../../src/adapters/activity-store.ts";
import type { TranscriptToolNode } from "../../src/adapters/store.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { createFieldEditor, type FieldEditor } from "../../src/views/config/view-host.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { WorkflowsHub } from "../../src/views/config/WorkflowsHub.tsx";

function fakeInteraction(): Interaction {
  const keymap = {
    registerLayer: () => () => {},
  } as unknown as Keymap<Renderable, KeyEvent>;
  return {
    keymap,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
    syncContext: () => {},
  } as unknown as Interaction;
}

function fakeHost(initial: OverlayKind = "none"): {
  host: OverlayHost;
  setOverlay: (k: OverlayKind) => void;
  setView: (v: { name: string; factory: (h: ViewHost) => unknown; host: ViewHost } | null) => void;
} {
  const [overlay, setOverlay] = createSignal<OverlayKind>(initial);
  type Frame = {
    name: string;
    factory: (h: ViewHost) => unknown;
    host: ViewHost;
  };
  const [views, setViews] = createSignal<Frame[]>([]);
  return {
    host: {
      overlay,
      views,
      view: () => views().at(-1) ?? null,
      viewDirty: () => false,
      openPicker: () => true,
      dismissTop: () => true,
      setRecheck: () => {},
      ui: {} as OverlayHost["ui"],
    } as unknown as OverlayHost,
    setOverlay,
    setView: (next) => setViews(next ? [next] : []),
  };
}

function activity(over: Partial<ActivityStore> = {}): ActivityStore {
  return createMutable({
    subagents: [],
    plan: null,
    usage: null,
    context: null,
    ...over,
  }) as unknown as ActivityStore;
}

async function settleLazyOverlay(rendered: Awaited<ReturnType<typeof openRender>>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await rendered.renderOnce();
    if (!rendered.captureCharFrame().includes("Loading ")) {
      await settleSyntaxSurfaces(rendered);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("lazy overlay module did not settle");
}

function toolNode(over: Partial<TranscriptToolNode> = {}): TranscriptToolNode {
  return {
    key: "n1",
    kind: "tool_call",
    status: "ok",
    text: "",
    mcpName: "",
    toolName: "edit_file",
    args: { path: "a.ts", old_string: "one", new_string: "ONE" },
    result: "Replaced 1 occurrence in a.ts.",
    error: null,
    collapsed: false,
    ...over,
  } as TranscriptToolNode;
}

test("with overlay none, the fallback shell renders and no overlay body appears", async () => {
  const { host } = fakeHost("none");
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={fakeInteraction()}
        diffNode={() => null}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("main shell content");
  t.renderer.destroy();
});

test("full-page overlays hide the shell without unmounting and rebuilding it", async () => {
  const { host, setOverlay } = fakeHost("none");
  let mounts = 0;
  let cleanups = 0;
  const Shell = () => {
    onMount(() => {
      mounts += 1;
      onCleanup(() => {
        cleanups += 1;
      });
    });
    return <text>persistent shell</text>;
  };
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<Shell />}
        interaction={fakeInteraction()}
        diffNode={() => toolNode()}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  expect(mounts).toBe(1);

  setOverlay("diff");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("persistent shell");
  expect(mounts).toBe(1);
  expect(cleanups).toBe(0);

  setOverlay("none");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("persistent shell");
  expect(mounts).toBe(1);
  expect(cleanups).toBe(0);
  t.renderer.destroy();
});

// `agentPicker` is a recognized kind, not an unrecognized one: it is a floating
// card over a scrim that `App` mounts beside this region, so the region must go
// on rendering the transcript behind it. Adding a `Match` for it here would black
// out everything the scrim exists to show through.
test("the floating 'agentPicker' kind keeps the main shell rendered behind it", async () => {
  const { host } = fakeHost("agentPicker");
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={fakeInteraction()}
        diffNode={() => null}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("main shell content");
  t.renderer.destroy();
});

test("an unrecognized overlay kind falls back to the main shell rather than blanking", async () => {
  const { host } = fakeHost("noSuchOverlay");
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={fakeInteraction()}
        diffNode={() => null}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("main shell content");
  t.renderer.destroy();
});

test("overlay 'view' renders the mounted view's factory with its own host, not the fallback", async () => {
  const { host, setOverlay, setView } = fakeHost("none");
  const viewHost = { active: () => true, dirty: () => false } as unknown as ViewHost;
  setView({
    name: "mock-view",
    factory: (h: ViewHost) => <text>rendered by factory, dirty={String(h.dirty())}</text>,
    host: viewHost,
  });
  setOverlay("view");
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={fakeInteraction()}
        diffNode={() => null}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("rendered by factory, dirty=false");
  expect(out).not.toContain("main shell content");
  t.renderer.destroy();
});

test("full-region views preserve the fallback owner and its Yoga geometry across repeated visits", async () => {
  const { host, setOverlay, setView } = fakeHost("none");
  const viewHost = { active: () => true, dirty: () => false } as unknown as ViewHost;
  let shellOwner: Renderable | undefined;
  let mounts = 0;
  let cleanups = 0;
  let factoryCalls = 0;
  const Shell = () => {
    onMount(() => {
      mounts += 1;
      onCleanup(() => {
        cleanups += 1;
      });
    });
    return (
      <box id="retained-shell-owner" ref={(value: Renderable) => (shellOwner = value)} flexGrow={1}>
        <text>retained transcript shell</text>
      </box>
    );
  };
  setView({
    name: "workflows",
    factory: () => {
      factoryCalls += 1;
      return <text>workflow browser</text>;
    },
    host: viewHost,
  });
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<Shell />}
        interaction={fakeInteraction()}
        diffNode={() => null}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  const original = shellOwner;
  const geometry = { width: original?.width, height: original?.height };
  expect(original).toBeDefined();
  expect(mounts).toBe(1);

  for (let cycle = 0; cycle < 12; cycle += 1) {
    setOverlay("view");
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("workflow browser");
    expect(t.captureCharFrame()).not.toContain("retained transcript shell");
    expect(shellOwner).toBe(original);
    expect(original?.isDestroyed).toBe(false);
    expect({ width: original?.width, height: original?.height }).toEqual(geometry);

    setOverlay("none");
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("retained transcript shell");
    expect(shellOwner).toBe(original);
  }

  expect(mounts).toBe(1);
  expect(cleanups).toBe(0);
  expect(factoryCalls).toBe(1);
  t.renderer.destroy();
});

test("state read while constructing a mounted view does not remount its factory", async () => {
  const { host, setOverlay, setView } = fakeHost("none");
  const viewHost = { active: () => true, dirty: () => false } as unknown as ViewHost;
  const [revision, setRevision] = createSignal(0);
  let factoryCalls = 0;
  setView({
    name: "reactive-view",
    factory: () => {
      factoryCalls += 1;
      revision();
      return <text>reactive view</text>;
    },
    host: viewHost,
  });
  setOverlay("view");
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={fakeInteraction()}
        diffNode={() => null}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  expect(factoryCalls).toBe(1);

  setRevision(1);
  await t.renderOnce();
  expect(factoryCalls).toBe(1);
  expect(t.captureCharFrame()).toContain("reactive view");
  t.renderer.destroy();
});

test("an empty WorkflowsHub inside OverlayRegion performs one mount and one initial list", async () => {
  const { keymap } = createFakeKeymap();
  const interaction = {
    keymap,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
  } as unknown as Interaction;
  const mountedView = createViewHost({
    interaction,
    close: () => {},
    dispatch: () => {},
  });
  const overlay = fakeHost("none");
  let factoryCalls = 0;
  let listCalls = 0;
  overlay.setView({
    name: "workflows",
    factory: () => {
      factoryCalls += 1;
      return WorkflowsHub(mountedView.host, {
        list: async () => {
          listCalls += 1;
          return { items: [], total: 0, limit: 20, offset: 0 };
        },
        get: async () => {
          throw new Error("not reached");
        },
        getRun: async () => null,
        now: () => 1,
      });
    },
    host: mountedView.host,
  });
  overlay.setOverlay("view");
  const t = await openRender(
    () => (
      <OverlayRegion
        host={overlay.host}
        fallback={<text>main shell content</text>}
        interaction={interaction}
        diffNode={() => null}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
    await t.renderOnce();
  }
  expect(t.captureCharFrame()).toContain("no workflows yet");
  expect(factoryCalls).toBe(1);
  expect(listCalls).toBe(1);
  t.renderer.destroy();
  mountedView.controls.dispose();
});

test("overlay 'view' with no mounted view falls through to the fallback (no crash)", async () => {
  const { host, setOverlay } = fakeHost("none");
  setOverlay("view");
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={fakeInteraction()}
        diffNode={() => null}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("main shell content");
  t.renderer.destroy();
});

test("a stacked child keeps its parent's editor mounted, unfocused, and intact on Escape", async () => {
  const { keymap, press } = createFakeKeymap();
  const interaction = {
    keymap,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
  } as unknown as Interaction;
  const host = createOverlayHost({
    interaction: () => interaction,
    runCommand: () => {},
    focusInput: () => {},
    notify: () => {},
  });
  let editor!: FieldEditor;
  let committed = "";
  host.ui.openView("parent", (viewHost) => {
    editor = createFieldEditor(viewHost.interaction, viewHost.active);
    return (
      <box flexDirection="column">
        <text>PARENT PAGE</text>
        <Show when={editor.editing()}>{editor.EditInput()}</Show>
      </box>
    );
  });
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={interaction}
        diffNode={() => null}
        activity={activity()}
      />
    ),
    { width: 100, height: 20 },
  );
  await t.renderOnce();
  editor.start("draft", "kept", (value) => (committed = value));
  await t.renderOnce();
  await t.mockInput.typeText(" plus child");
  await t.renderOnce();

  host.ui.openView("child", () => <text>CHILD PAGE</text>);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("CHILD PAGE");
  expect(t.captureCharFrame()).not.toContain("PARENT PAGE");
  press("return");
  expect(committed).toBe("");

  press("escape");
  await t.renderOnce();
  const restored = t.captureCharFrame();
  expect(restored).toContain("PARENT PAGE");
  expect(restored).toContain("kept plus child");
  press("return");
  expect(committed).toBe("kept plus child");
  t.renderer.destroy();
});

test("overlay 'diff' with no picked node shows the DiffViewer empty state", async () => {
  const { host, setOverlay } = fakeHost("none");
  setOverlay("diff");
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={fakeInteraction()}
        diffNode={() => null}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  const first = t.captureCharFrame();
  expect(first.includes("Loading diff…") || first.includes("no diff in the transcript yet")).toBe(
    true,
  );
  await settleLazyOverlay(t);
  const out = t.captureCharFrame();
  expect(out).toContain("no diff in the transcript yet");
  expect(out).not.toContain("main shell content");
  t.renderer.destroy();
});

test("overlay 'diff' with a picked node renders that tool's diff", async () => {
  const { host, setOverlay } = fakeHost("none");
  setOverlay("diff");
  const node = toolNode();
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={fakeInteraction()}
        diffNode={() => node}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await settleLazyOverlay(t);
  const out = t.captureCharFrame();
  expect(out).toContain("ONE");
  expect(out).not.toContain("main shell content");
  t.renderer.destroy();
});

test("overlay 'plan' renders the plan overlay from the activity store's live plan", async () => {
  const { host, setOverlay } = fakeHost("none");
  setOverlay("plan");
  const a = activity({
    plan: {
      path: ".clarvis/plans/x.md",
      title: "Overlay-region plan",
      status: "active",
      retention: "keep",
      revision: 1,
      spec_revision: 1,
      tasks: [{ id: "t1", title: "Do the thing", status: "in_progress" }],
    } as ActivityStore["plan"],
  });
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={fakeInteraction()}
        diffNode={() => null}
        activity={a}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await settleLazyOverlay(t);
  const out = t.captureCharFrame();
  expect(out).toContain("Plan · Running · 0/1 tasks done");
  expect(out).toContain("Do the thing");
  expect(out).not.toContain("main shell content");
  t.renderer.destroy();
});

test("overlay 'plan' with no live plan falls back to the plan overlay's own empty state", async () => {
  const { host, setOverlay } = fakeHost("none");
  setOverlay("plan");
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={fakeInteraction()}
        diffNode={() => null}
        activity={activity()}
        plans={undefined}
      />
    ),
    { width: 100, height: 30 },
  );
  await settleLazyOverlay(t);
  const out = t.captureCharFrame();
  expect(out).toContain("no plan yet");
  t.renderer.destroy();
});

test("the plan overlay never reads retained history without a live plan", async () => {
  const { host, setOverlay } = fakeHost("none");
  setOverlay("plan");
  let reads = 0;
  const plans = {
    read: async () => {
      reads += 1;
      throw new Error("history must stay unreachable");
    },
  };
  const t = await openRender(
    () => (
      <OverlayRegion
        host={host}
        fallback={<text>main shell content</text>}
        interaction={fakeInteraction()}
        diffNode={() => null}
        activity={activity()}
        plans={plans}
      />
    ),
    { width: 100, height: 30 },
  );
  await settleLazyOverlay(t);
  expect(t.captureCharFrame()).toContain("no plan yet");
  expect(reads).toBe(0);
  t.renderer.destroy();
});
