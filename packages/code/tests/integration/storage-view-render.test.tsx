import { expect, test } from "bun:test";
import type { StorageCleanupResult, StorageSnapshot } from "@clarvis/protocol";
import type { Interaction } from "../../src/keys/interaction.ts";
import { StorageView } from "../../src/views/config/StorageView.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";

const snapshot = (reclaimableBytes = 2048, truncated = false): StorageSnapshot => ({
  generated_at: 1,
  total_bytes: 4096,
  reclaimable_bytes: reclaimableBytes,
  truncated,
  categories: [
    {
      category: "spills",
      files: 2,
      directories: 1,
      bytes: 2048,
      reclaimable_bytes: reclaimableBytes,
    },
    {
      category: "sessions",
      files: 1,
      directories: 0,
      bytes: 2048,
      reclaimable_bytes: 0,
    },
  ],
  credentials: {
    keys: { present: true, owner_only: false },
    subscriptions: { present: true, owner_only: null },
  },
});

test("/storage renders bounded metadata and cleans disposable data only after confirmation", async () => {
  const { keymap, press } = createFakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const requests: Array<{ categories: string[]; dry_run: boolean }> = [];
  const notes: string[] = [];
  const clean = snapshot(0);
  const cleanup = async (request: {
    categories: Array<"temporary" | "cache">;
    dry_run: boolean;
  }) => {
    requests.push(request);
    return {
      dry_run: request.dry_run,
      reclaimable_bytes: 2048,
      removed_bytes: request.dry_run ? 0 : 2048,
      before: snapshot(),
      after: request.dry_run ? undefined : clean,
    } satisfies StorageCleanupResult;
  };
  const view = () =>
    StorageView(host, {
      storage: { inspect: async () => snapshot(2048, true), cleanup },
      notify: (message) => notes.push(message),
    });
  const rendered = await openRender(view as never, { width: 100, height: 24 });

  await rendered.renderOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("4.00 KiB");
  expect(frame).toContain("bounded scan truncated");
  expect(frame).toContain("permissions need repair");
  expect(frame).toContain("permissions unavailable");

  press("c");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("clean 2.00 KiB of disposable storage?");
  press("y");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rendered.renderOnce();

  expect(requests).toEqual([
    { categories: ["temporary", "cache"], dry_run: true },
    { categories: ["temporary", "cache"], dry_run: false },
  ]);
  expect(notes).toContain("Cleaned 2.00 KiB of disposable storage");
  rendered.renderer.destroy();
});

test("/storage reports an empty cleanup preview without asking for confirmation", async () => {
  const { keymap, press } = createFakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const notes: string[] = [];
  const view = () =>
    StorageView(host, {
      storage: {
        inspect: async () => snapshot(0),
        cleanup: async (request) => ({
          dry_run: request.dry_run,
          reclaimable_bytes: 0,
          removed_bytes: 0,
          before: snapshot(0),
        }),
      },
      notify: (message) => notes.push(message),
    });
  const rendered = await openRender(view as never, { width: 100, height: 20 });

  await rendered.renderOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  press("c");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(notes).toContain("No disposable storage is currently reclaimable");
  expect(host.pendingConfirm()).toBeNull();
  rendered.renderer.destroy();
});

test("/storage refuses cleanup when the bounded preview is incomplete", async () => {
  const { keymap, press } = createFakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const requests: boolean[] = [];
  const notes: string[] = [];
  const view = () =>
    StorageView(host, {
      storage: {
        inspect: async () => snapshot(2048, true),
        cleanup: async (request) => {
          requests.push(request.dry_run);
          return {
            dry_run: request.dry_run,
            reclaimable_bytes: 2048,
            removed_bytes: 0,
            before: snapshot(2048, true),
          };
        },
      },
      notify: (message) => notes.push(message),
    });
  const rendered = await openRender(view as never, { width: 100, height: 20 });

  await rendered.renderOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  press("c");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(requests).toEqual([true]);
  expect(notes).toContain("Cleanup unavailable: storage inventory is incomplete");
  expect(host.pendingConfirm()).toBeNull();
  rendered.renderer.destroy();
});
