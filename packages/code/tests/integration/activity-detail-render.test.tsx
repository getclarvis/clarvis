import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { ActivityDetail as ActivityDetailValue } from "../../src/views/activity-detail.ts";
import { SurfaceBoundary } from "../../src/ui/patterns/surface-lifecycle.tsx";
import { ActivityDetail } from "../../src/views/overlays/ActivityDetail.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";

test("activity detail renders the original Markdown and Escape closes it", async () => {
  const { keymap, press } = createFakeKeymap();
  const interaction = { keymap } as unknown as Interaction;
  let closed = 0;
  const t = await openRender(
    () => (
      <ActivityDetail
        interaction={interaction}
        detail={() => ({
          title: "Research result",
          eyebrow: "Completed sub-agent response",
          content: "## Findings\n\n| check | status |\n| --- | --- |\n| guard | **fixed** |",
        })}
        onClose={() => (closed += 1)}
      />
    ),
    { width: 100, height: 30 },
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Research result");
  expect(frame).toContain("guard");
  expect(frame).toContain("fixed");

  press("escape");
  expect(closed).toBe(1);
  t.renderer.destroy();
});

test("a retained activity detail gates one key layer and releases its document payload", async () => {
  const { keymap, press, layers } = createFakeKeymap();
  const interaction = { keymap } as unknown as Interaction;
  const [active, setActive] = createSignal(false);
  const [detail, setDetail] = createSignal<ActivityDetailValue | null>(null);
  let closed = 0;
  const t = await openRender(
    () => (
      <SurfaceBoundary active={active} retention="retain-one" placement="portal">
        {() => (
          <ActivityDetail interaction={interaction} detail={detail} onClose={() => closed++} />
        )}
      </SurfaceBoundary>
    ),
    { width: 100, height: 30 },
  );

  setDetail({ title: "Large retained result", content: "payload that must be released" });
  setActive(true);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Large retained result");
  expect(layers).toHaveLength(1);

  setActive(false);
  setDetail(null);
  await t.renderOnce();
  press("escape");
  expect(closed).toBe(0);
  expect(layers).toHaveLength(1);

  setActive(true);
  await t.renderOnce();
  const reopened = t.captureCharFrame();
  expect(reopened).toContain("Activity detail");
  expect(reopened).not.toContain("Large retained result");
  t.renderer.destroy();
});
