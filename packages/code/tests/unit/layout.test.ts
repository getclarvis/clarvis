import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import {
  createLayoutController,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  INSPECTOR_SPLIT_MIN_WIDTH,
  type LayoutMode,
  type SecondaryOrigin,
} from "../../src/app/layout.ts";

function harness(
  initialDims: { w: number; h: number },
  initialHasContent = false,
): {
  controller: ReturnType<typeof createLayoutController>;
  setDims: (d: { w: number; h: number }) => void;
  setHasContent: (v: boolean) => void;
  collapses: number[];
  dispose: () => void;
} {
  let controller!: ReturnType<typeof createLayoutController>;
  let setDims!: (d: { w: number; h: number }) => void;
  let setHasContent!: (v: boolean) => void;
  const collapses: number[] = [];
  const dispose = createRoot((d) => {
    const [dims, _setDims] = createSignal(initialDims);
    const [hasContent, _setHasContent] = createSignal(initialHasContent);
    setDims = _setDims;
    setHasContent = _setHasContent;
    controller = createLayoutController({
      dims,
      hasSidebarContent: hasContent,
      onAutomaticCollapse: () => collapses.push(1),
    });
    return d;
  });
  return { controller, setDims, setHasContent, collapses, dispose };
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

test("splitEligible follows the 100-column boundary", () => {
  for (const w of [24, 40, 71, 72, 84, 99]) {
    const { controller, dispose } = harness({ w, h: 40 });
    expect([w, controller.splitEligible()]).toEqual([w, false]);
    dispose();
  }
  for (const w of [100, 120, 200]) {
    const { controller, dispose } = harness({ w, h: 40 });
    expect([w, controller.splitEligible()]).toEqual([w, true]);
    dispose();
  }
});

test("the secondary surface changes only after explicit content-backed intent", () => {
  const { controller, setHasContent, dispose } = harness({ w: 200, h: 60 }, false);
  expect(controller.sidebarVisible()).toBe(false);
  setHasContent(true);
  expect(controller.sidebarVisible()).toBe(false);
  controller.openSecondary("explicit");
  expect(controller.sidebarVisible()).toBe(true);
  expect(controller.secondaryOrigin()).toBe("explicit");
  setHasContent(false);
  expect(controller.sidebarVisible()).toBe(true);
  expect(controller.secondaryOpen()).toBe(true);
  setHasContent(true);
  expect(controller.sidebarVisible()).toBe(true);
  controller.closeSecondary();
  expect(controller.sidebarVisible()).toBe(false);
  expect(controller.secondaryOpen()).toBe(false);
  expect(controller.secondaryOrigin()).toBe(null);
  dispose();
});

test("contentInset is inspector width only when the split is eligible and visible", () => {
  const wide = harness({ w: 200, h: 60 }, true);
  expect(wide.controller.contentInset()).toBe(0);
  wide.controller.openSecondary("explicit");
  expect(wide.controller.contentInset()).toBe(INSPECTOR_MAX_WIDTH);
  wide.dispose();

  const wideHidden = harness({ w: 200, h: 60 }, false);
  expect(wideHidden.controller.contentInset()).toBe(0);
  wideHidden.controller.openSecondary("explicit");
  expect(wideHidden.controller.secondaryOpen()).toBe(false);
  expect(wideHidden.controller.contentInset()).toBe(0);
  wideHidden.dispose();

  const below = harness({ w: 84, h: 40 }, true);
  below.controller.openSecondary("explicit");
  expect(below.controller.secondaryMode()).toBe("full");
  expect(below.controller.contentInset()).toBe(0);
  below.dispose();
});

test("the exact split boundary opens a 32-column inspector at 100 columns", () => {
  const below = harness({ w: INSPECTOR_SPLIT_MIN_WIDTH - 1, h: 40 }, true);
  expect(below.controller.secondaryMode()).toBe("closed");
  expect(below.controller.sidebarVisible()).toBe(false);
  below.controller.openSecondary("explicit");
  expect(below.controller.secondaryMode()).toBe("full");
  expect(below.controller.contentInset()).toBe(0);
  below.dispose();

  const at = harness({ w: INSPECTOR_SPLIT_MIN_WIDTH, h: 40 }, true);
  expect(at.controller.secondaryMode()).toBe("closed");
  at.controller.openSecondary("explicit");
  expect(at.controller.secondaryMode()).toBe("split");
  expect(at.controller.sidebarWidth()).toBe(INSPECTOR_MIN_WIDTH);
  expect(INSPECTOR_SPLIT_MIN_WIDTH - at.controller.sidebarWidth()).toBe(68);
  at.dispose();
});

test("every width below the split presents the whole-region panel, never a residual drawer", () => {
  for (const w of [24, 40, 71, 72, 84, 99]) {
    const { controller, collapses, dispose } = harness({ w, h: 24 }, true);
    controller.openSecondary("explicit");
    expect([w, controller.secondaryMode()]).toEqual([w, "full"]);
    expect([w, controller.sidebarVisible()]).toEqual([w, false]);
    expect([w, controller.contentInset()]).toEqual([w, 0]);
    expect([w, collapses]).toEqual([w, []]);
    controller.closeSecondary();
    expect([w, controller.secondaryMode()]).toEqual([w, "closed"]);
    dispose();
  }
});

test("an automatic intent never keeps a surface open below the split", () => {
  for (const w of [40, 72, 84, 99]) {
    const { controller, collapses, dispose } = harness({ w, h: 24 }, true);
    controller.openSecondary("automatic");
    expect([w, controller.secondaryMode()]).toEqual([w, "closed"]);
    expect([w, controller.secondaryOpen()]).toEqual([w, false]);
    expect([w, controller.secondaryOrigin()]).toEqual([w, null]);
    expect([w, collapses.length > 0]).toEqual([w, true]);
    dispose();
  }
});

test("a width that stops supporting the split collapses an automatic surface once", () => {
  const { controller, setDims, collapses, dispose } = harness({ w: 140, h: 40 }, true);
  controller.openSecondary("automatic");
  expect(controller.secondaryMode()).toBe("split");
  setDims({ w: 99, h: 40 });
  expect(controller.secondaryMode()).toBe("closed");
  expect(controller.secondaryOpen()).toBe(false);
  expect(collapses).toEqual([1]);
  setDims({ w: 84, h: 40 });
  expect(controller.secondaryMode()).toBe("closed");
  setDims({ w: 140, h: 40 });
  expect(controller.secondaryMode()).toBe("closed");
  expect(collapses).toEqual([1]);
  dispose();
});

test("an explicit surface survives the shrink and adapts as the width returns", () => {
  const { controller, setDims, collapses, dispose } = harness({ w: 140, h: 30 }, true);
  controller.openSecondary("explicit");
  expect(controller.secondaryMode()).toBe("split");
  setDims({ w: 84, h: 30 });
  expect(controller.secondaryMode()).toBe("full");
  expect(controller.secondaryOrigin()).toBe("explicit");
  setDims({ w: 72, h: 30 });
  expect(controller.secondaryMode()).toBe("full");
  setDims({ w: 140, h: 30 });
  expect(controller.secondaryMode()).toBe("split");
  expect(controller.secondaryOrigin()).toBe("explicit");
  expect(collapses).toEqual([]);
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

test("an origin is recorded for every open and cleared with the surface", () => {
  const origins: SecondaryOrigin[] = ["automatic", "explicit"];
  for (const origin of origins) {
    const { controller, dispose } = harness({ w: 140, h: 40 }, true);
    controller.openSecondary(origin);
    expect(controller.secondaryOrigin()).toBe(origin);
    controller.closeSecondary();
    expect(controller.secondaryOrigin()).toBe(null);
    dispose();
  }
});
