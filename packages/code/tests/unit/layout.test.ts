import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import {
  createLayoutController,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  INSPECTOR_SPLIT_MIN_WIDTH,
  type LayoutMode,
} from "../../src/app/layout.ts";

function harness(
  initialDims: { w: number; h: number },
  initialHasContent = false,
): {
  controller: ReturnType<typeof createLayoutController>;
  setDims: (d: { w: number; h: number }) => void;
  setHasContent: (v: boolean) => void;
  dispose: () => void;
} {
  let controller!: ReturnType<typeof createLayoutController>;
  let setDims!: (d: { w: number; h: number }) => void;
  let setHasContent!: (v: boolean) => void;
  const dispose = createRoot((d) => {
    const [dims, _setDims] = createSignal(initialDims);
    const [hasContent, _setHasContent] = createSignal(initialHasContent);
    setDims = _setDims;
    setHasContent = _setHasContent;
    controller = createLayoutController({ dims, hasSidebarContent: hasContent });
    return d;
  });
  return { controller, setDims, setHasContent, dispose };
}

test("layoutModeFromDims: width/height thresholds pick floor, single, narrow, wide", () => {
  const cases: [{ w: number; h: number }, LayoutMode][] = [
    [{ w: 23, h: 40 }, "floor"],
    [{ w: 100, h: 5 }, "floor"],
    [{ w: 24, h: 6 }, "single"],
    [{ w: 36, h: 40 }, "single"],
    [{ w: 48, h: 40 }, "single"],
    [{ w: 71, h: 40 }, "single"],
    [{ w: 72, h: 40 }, "narrow"],
    [{ w: 99, h: 40 }, "narrow"],
    [{ w: 100, h: 40 }, "wide"],
    [{ w: 119, h: 40 }, "wide"],
    [{ w: 120, h: 40 }, "wide"],
    [{ w: 124, h: 40 }, "wide"],
    [{ w: 160, h: 40 }, "wide"],
    [{ w: 200, h: 60 }, "wide"],
  ];
  for (const [dims, expected] of cases) {
    const { controller, dispose } = harness(dims);
    expect([dims, controller.layoutMode()]).toEqual([dims, expected]);
    dispose();
  }
});

test("inspector width stays useful when possible and clamps to the viewport", () => {
  const wide = harness({ w: 200, h: 60 });
  expect(wide.controller.sidebarWidth()).toBe(INSPECTOR_MAX_WIDTH);
  wide.dispose();

  const narrow = harness({ w: 80, h: 40 });
  expect(narrow.controller.sidebarWidth()).toBe(INSPECTOR_MIN_WIDTH);
  narrow.dispose();

  const single = harness({ w: 50, h: 40 });
  expect(single.controller.sidebarWidth()).toBe(INSPECTOR_MIN_WIDTH);
  single.dispose();

  const minimumSupported = harness({ w: 24, h: 40 });
  expect(minimumSupported.controller.sidebarWidth()).toBe(24);
  minimumSupported.dispose();

  const compact = harness({ w: 36, h: 40 });
  expect(compact.controller.sidebarWidth()).toBe(INSPECTOR_MIN_WIDTH);
  compact.dispose();
});

test("sidebar visibility changes only after explicit intent at split-capable widths", () => {
  const { controller, setHasContent, dispose } = harness({ w: 200, h: 60 }, false);
  expect(controller.sidebarVisible()).toBe(false);
  setHasContent(true);
  expect(controller.sidebarVisible()).toBe(false);
  controller.setDrawerOpen(true);
  expect(controller.sidebarVisible()).toBe(true);
  setHasContent(false);
  expect(controller.sidebarVisible()).toBe(true);
  expect(controller.drawerOpen()).toBe(true);
  setHasContent(true);
  expect(controller.sidebarVisible()).toBe(true);
  controller.setDrawerOpen(false);
  expect(controller.sidebarVisible()).toBe(false);
  dispose();
});

test("contentInset is inspector width only when the split is eligible and visible", () => {
  const wide = harness({ w: 200, h: 60 }, true);
  expect(wide.controller.contentInset()).toBe(0);
  wide.controller.setDrawerOpen(true);
  expect(wide.controller.contentInset()).toBe(INSPECTOR_MAX_WIDTH);
  wide.dispose();

  const wideHidden = harness({ w: 200, h: 60 }, false);
  expect(wideHidden.controller.contentInset()).toBe(0);
  wideHidden.controller.setDrawerOpen(true);
  expect(wideHidden.controller.drawerOpen()).toBe(false);
  expect(wideHidden.controller.contentInset()).toBe(0);
  wideHidden.dispose();

  const single = harness({ w: 50, h: 40 }, true);
  expect(single.controller.layoutMode()).toBe("single");
  expect(single.controller.contentInset()).toBe(0);
  single.dispose();
});

test("the exact split boundary opens a 32-column inspector at 100 columns", () => {
  const below = harness({ w: INSPECTOR_SPLIT_MIN_WIDTH - 1, h: 40 }, true);
  expect(below.controller.secondaryMode()).toBe("closed");
  expect(below.controller.sidebarVisible()).toBe(false);
  below.controller.setDrawerOpen(true);
  expect(below.controller.secondaryMode()).toBe("drawer");
  expect(below.controller.contentInset()).toBe(0);
  below.dispose();

  const at = harness({ w: INSPECTOR_SPLIT_MIN_WIDTH, h: 40 }, true);
  expect(at.controller.secondaryMode()).toBe("closed");
  at.controller.setDrawerOpen(true);
  expect(at.controller.secondaryMode()).toBe("split");
  expect(at.controller.sidebarWidth()).toBe(INSPECTOR_MIN_WIDTH);
  expect(INSPECTOR_SPLIT_MIN_WIDTH - at.controller.sidebarWidth()).toBe(68);
  at.dispose();
});

test("the compact drawer is opened and closed explicitly", () => {
  const { controller, dispose } = harness({ w: 50, h: 40 }, true);
  expect(controller.layoutMode()).toBe("single");
  expect(controller.drawerOpen()).toBe(false);
  controller.setDrawerOpen(true);
  expect(controller.drawerOpen()).toBe(true);
  controller.setDrawerOpen(false);
  expect(controller.drawerOpen()).toBe(false);
  dispose();
});

test("setDrawerOpen accepts both a direct value and an updater function", () => {
  const { controller, dispose } = harness({ w: 50, h: 40 }, true);
  controller.setDrawerOpen(true);
  expect(controller.drawerOpen()).toBe(true);
  controller.setDrawerOpen((prev) => !prev);
  expect(controller.drawerOpen()).toBe(false);
  dispose();
});

test("layoutMode reacts to dims changing at runtime (crossing every threshold)", () => {
  const { controller, setDims, dispose } = harness({ w: 200, h: 60 });
  expect(controller.layoutMode()).toBe("wide");
  setDims({ w: 90, h: 60 });
  expect(controller.layoutMode()).toBe("narrow");
  setDims({ w: 60, h: 60 });
  expect(controller.layoutMode()).toBe("single");
  setDims({ w: 10, h: 60 });
  expect(controller.layoutMode()).toBe("floor");
  dispose();
});
