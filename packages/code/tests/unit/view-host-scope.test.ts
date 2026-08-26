import { expect, test } from "bun:test";
import { createViewHost, type ViewHostControls } from "../../src/views/config/view-host.tsx";
import type { ViewHost } from "../../src/keys/commands.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

function makeHost(): {
  host: ViewHost;
  controls: ViewHostControls;
  press: (key: string) => void;
  closes: () => number;
} {
  const { keymap, press } = fakeKeymap();
  let closed = 0;
  const { host, controls } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {
      closed++;
    },
    dispatch: () => {},
  });
  return { host, controls, press, closes: () => closed };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("^t default (retarget): a dirty draft survives the toggle, no confirm fires", () => {
  const { host } = makeHost();
  host.markDirty(true);
  host.toggleScope();
  expect(host.scope()).toBe("workspace");
  expect(host.pendingConfirm()).toBeNull();
  expect(host.dirty()).toBe(true);
});

test("^t reload + clean: flips and re-reads via the bound load", () => {
  const { host } = makeHost();
  const loads: string[] = [];
  host.bindScope({ mode: "reload", load: () => loads.push(host.scope()) });
  host.toggleScope();
  expect(host.scope()).toBe("workspace");
  expect(loads).toEqual(["workspace"]);
});

test("^t reload + dirty: confirms with the discard consequence; n keeps, y discards+reloads", async () => {
  const { host, press } = makeHost();
  const loads: number[] = [];
  host.bindScope({
    mode: "reload",
    load: () => {
      loads.push(1);
      host.markDirty(false);
    },
  });
  host.markDirty(true);

  host.toggleScope();
  expect(host.pendingConfirm()?.message).toContain("discards");
  expect(host.scope()).toBe("global");
  press("n");
  await flush();
  expect(host.scope()).toBe("global");
  expect(host.dirty()).toBe(true);
  expect(loads).toEqual([]);

  host.toggleScope();
  press("y");
  await flush();
  expect(host.scope()).toBe("workspace");
  expect(loads).toEqual([1]);
  expect(host.dirty()).toBe(false);
});

test("dispose runs the pending cancel handler exactly once (force-dismiss path)", () => {
  const { host, controls } = makeHost();
  let cancels = 0;
  host.onCancel(() => cancels++);
  host.markDirty(true);
  controls.dispose();
  expect(cancels).toBe(1);
  controls.dispose();
  expect(cancels).toBe(1);
});

test("runSave is single-flight and permits a later retry after settlement", async () => {
  const { host, controls } = makeHost();
  let saves = 0;
  let release!: () => void;
  host.onSave(async () => {
    saves++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });

  const first = controls.runSave();
  const duplicate = controls.runSave();
  expect(duplicate).toBe(first);
  expect(saves).toBe(1);
  release();
  await first;

  const retry = controls.runSave();
  expect(saves).toBe(2);
  release();
  await retry;
});

test("escape then dispose (the normal close path) does not double-invoke cancel", () => {
  const { host, controls, closes } = makeHost();
  let cancels = 0;
  host.onCancel(() => cancels++);
  controls.escape();
  expect(cancels).toBe(1);
  expect(closes()).toBe(1);
  controls.dispose();
  expect(cancels).toBe(1);
});

test("escape over a dirty view runs cancel once after the confirm, dispose stays a no-op", async () => {
  const { host, controls, press, closes } = makeHost();
  let cancels = 0;
  host.onCancel(() => cancels++);
  host.markDirty(true);
  controls.escape();
  expect(host.pendingConfirm()?.message).toContain("Discard");
  press("y");
  await flush();
  expect(cancels).toBe(1);
  expect(closes()).toBe(1);
  controls.dispose();
  expect(cancels).toBe(1);
});
