import { expect, test } from "bun:test";
import { Show } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import { createFieldEditor } from "../../src/views/config/view-host.tsx";
import { applyAsciiMode } from "../../src/theme/glyphs.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

function fakeKeymap(): { keymap: Interaction; press: (this: void, key: string) => void } {
  const { keymap: inner, press } = createFakeKeymap();
  const keymap = { keymap: inner } as unknown as Interaction;
  return { keymap, press };
}

test("secret mode: typed characters render as bullets, Enter commits the plaintext", async () => {
  const { keymap, press } = fakeKeymap();
  const fe = createFieldEditor(keymap);
  let committed: string | null = null;
  fe.startSecret("API key → TEST_KEY", (v) => {
    committed = v;
  });
  const t = await openRender((() => <Show when={fe.editing()}>{fe.EditInput()}</Show>) as never, {
    width: 100,
    height: 10,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("API key → TEST_KEY");
  await t.mockInput.typeText("abc");
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("•••");
  expect(out).not.toContain("abc");
  press("return");
  expect(committed as string | null).toBe("abc");
  expect(fe.editing()).toBeNull();
  t.renderer.destroy();
});

test("secret mode: in ASCII mode a key containing '*' commits intact (mask never collides with input)", async () => {
  applyAsciiMode(true);
  try {
    const { keymap, press } = fakeKeymap();
    const fe = createFieldEditor(keymap);
    let committed: string | null = null;
    fe.startSecret("k", (v) => {
      committed = v;
    });
    const t = await openRender((() => <Show when={fe.editing()}>{fe.EditInput()}</Show>) as never, {
      width: 100,
      height: 10,
    });
    await t.renderOnce();
    await t.mockInput.typeText("ab*cd");
    await t.renderOnce();
    press("return");
    expect(committed as string | null).toBe("ab*cd");
    t.renderer.destroy();
  } finally {
    applyAsciiMode(false);
  }
});

test("secret mode: cursor-movement keys are pinned, typing always appends to the plaintext", async () => {
  const { keymap, press } = fakeKeymap();
  const fe = createFieldEditor(keymap);
  let committed: string | null = null;
  fe.startSecret("k", (v) => {
    committed = v;
  });
  const t = await openRender((() => <Show when={fe.editing()}>{fe.EditInput()}</Show>) as never, {
    width: 100,
    height: 10,
  });
  await t.renderOnce();
  await t.mockInput.typeText("abc");
  await t.renderOnce();
  t.mockInput.pressKey("ARROW_LEFT");
  await t.renderOnce();
  await t.mockInput.typeText("x");
  await t.renderOnce();
  t.mockInput.pressKey("HOME");
  await t.renderOnce();
  await t.mockInput.typeText("y");
  await t.renderOnce();
  press("return");
  expect(committed as string | null).toBe("abcxy");
  t.renderer.destroy();
});

test("secret mode: backspace shortens, Esc cancels without committing", async () => {
  const { keymap, press } = fakeKeymap();
  const fe = createFieldEditor(keymap);
  let committed: string | null = null;
  fe.startSecret("k", (v) => {
    committed = v;
  });
  const t = await openRender((() => <Show when={fe.editing()}>{fe.EditInput()}</Show>) as never, {
    width: 100,
    height: 10,
  });
  await t.renderOnce();
  await t.mockInput.typeText("ab");
  await t.renderOnce();
  t.mockInput.pressKey("BACKSPACE");
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("•");
  expect(out).not.toContain("••");
  press("escape");
  expect(fe.editing()).toBeNull();
  expect(committed).toBeNull();
  t.renderer.destroy();
});
