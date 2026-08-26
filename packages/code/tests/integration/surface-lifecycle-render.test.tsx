import { expect, test } from "bun:test";
import { createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import {
  onSurfaceActivate,
  onSurfaceDeactivate,
  SurfaceBoundary,
  SurfacePortal,
  SurfaceRegion,
  useSurfaceActivationGuard,
  useSurfaceFocus,
  useSurfaceLifecycle,
} from "../../src/ui/patterns/surface-lifecycle.tsx";
import { FloatFrame } from "../../src/views/overlays/FloatFrame.tsx";

function lifecycleProbe(events: string[]): () => JSX.Element {
  return function Probe(): JSX.Element {
    const lifecycle = useSurfaceLifecycle();
    onMount(() => {
      events.push("mount");
      onCleanup(() => events.push("cleanup"));
    });
    onSurfaceActivate((activation) => {
      events.push(`activate:${activation}`);
      return () => events.push(`release:${activation}`);
    });
    onSurfaceDeactivate(() => events.push("deactivate"));
    return (
      <SurfaceRegion>
        <text>{`surface ${lifecycle.activation()}`}</text>
      </SurfaceRegion>
    );
  };
}

test("dispose-on-close gives every activation a fresh Solid and OpenTUI subtree", async () => {
  const [active, setActive] = createSignal(false);
  const events: string[] = [];
  const Probe = lifecycleProbe(events);
  const t = await openRender(
    () => (
      <SurfaceBoundary active={active} retention="dispose-on-close">
        {() => <Probe />}
      </SurfaceBoundary>
    ),
    { width: 40, height: 8 },
  );

  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("surface");
  expect(events).toEqual([]);

  setActive(true);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("surface 1");
  expect(events).toContain("mount");
  expect(events).toContain("activate:1");

  setActive(false);
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("surface");
  expect(events).toContain("release:1");
  expect(events).toContain("deactivate");
  expect(events).toContain("cleanup");

  setActive(true);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("surface 2");
  expect(events.filter((event) => event === "mount")).toHaveLength(2);
  t.renderer.destroy();
});

test("retain-one mounts once, hides from layout and reactivates the same subtree", async () => {
  const [active, setActive] = createSignal(false);
  const events: string[] = [];
  const Probe = lifecycleProbe(events);
  const t = await openRender(
    () => (
      <SurfaceBoundary active={active} retention="retain-one">
        {() => <Probe />}
      </SurfaceBoundary>
    ),
    { width: 40, height: 8 },
  );

  setActive(true);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("surface 1");

  setActive(false);
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("surface");
  expect(events.filter((event) => event === "mount")).toHaveLength(1);
  expect(events.filter((event) => event === "cleanup")).toHaveLength(0);

  setActive(true);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("surface 2");
  expect(events.filter((event) => event === "mount")).toHaveLength(1);
  expect(events).toContain("activate:2");

  t.renderer.destroy();
  expect(events.filter((event) => event === "cleanup")).toHaveLength(1);
});

test("SurfacePortal escapes a clipped page region and paints from the renderer root", async () => {
  const t = await openRender(
    () => (
      <box width={5} height={1} overflow="hidden">
        <SurfaceBoundary active={() => true} retention="dispose-on-close">
          {() => (
            <SurfacePortal>
              <box position="absolute" left={12} top={3} width={12} height={1}>
                <text>portal text</text>
              </box>
            </SurfacePortal>
          )}
        </SurfaceBoundary>
      </box>
    ),
    { width: 40, height: 8 },
  );
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("portal text");
  t.renderer.destroy();
});

test("retained focus and async guards follow activation identity", async () => {
  const [active, setActive] = createSignal(false);
  const focusEvents: string[] = [];
  let current = (): boolean => false;
  const target = {
    focus: () => focusEvents.push("focus"),
    blur: () => focusEvents.push("blur"),
  };
  const Probe = (): JSX.Element => {
    const guard = useSurfaceActivationGuard();
    useSurfaceFocus(() => target);
    onSurfaceActivate(() => {
      current = guard.capture();
    });
    return (
      <SurfaceRegion>
        <text>guarded</text>
      </SurfaceRegion>
    );
  };
  const t = await openRender(
    () => (
      <SurfaceBoundary active={active} retention="retain-one">
        {() => <Probe />}
      </SurfaceBoundary>
    ),
    { width: 40, height: 8 },
  );

  setActive(true);
  await t.renderOnce();
  expect(focusEvents).toEqual(["focus"]);
  expect(current()).toBe(true);
  const firstActivation = current;

  setActive(false);
  await t.renderOnce();
  expect(focusEvents).toEqual(["focus", "blur"]);
  expect(firstActivation()).toBe(false);

  setActive(true);
  await t.renderOnce();
  expect(focusEvents).toEqual(["focus", "blur", "focus"]);
  expect(current()).toBe(true);
  expect(firstActivation()).toBe(false);
  t.renderer.destroy();
});

test("a retained portal keeps one bounded FloatFrame lifecycle set", async () => {
  const [active, setActive] = createSignal(false);
  const t = await openRender(
    () => (
      <SurfaceBoundary active={active} retention="retain-one" placement="portal">
        {() => (
          <FloatFrame title="timeline probe">
            <text>probe</text>
          </FloatFrame>
        )}
      </SurfaceBoundary>
    ),
    { width: 60, height: 12 },
  );
  await t.renderOnce();
  const baseline = t.renderer.getLifecyclePasses().size;

  setActive(true);
  await t.renderOnce();
  setActive(false);
  await t.renderOnce();
  const retainedBaseline = t.renderer.getLifecyclePasses().size;
  expect(retainedBaseline).toBeGreaterThan(baseline);

  for (let cycle = 1; cycle < 12; cycle += 1) {
    setActive(true);
    await t.renderOnce();
    setActive(false);
    await t.renderOnce();
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await new Promise<void>((resolve) => process.nextTick(resolve));
    await t.renderOnce();
  }

  expect(t.renderer.getLifecyclePasses().size).toBe(retainedBaseline);
  t.renderer.destroy();
});
