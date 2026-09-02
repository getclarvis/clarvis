import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { BootFrame } from "../../src/views/BootFrame.tsx";
import {
  createStartupComposerState,
  resolveStartupComposerHandoff,
  StartupComposer,
} from "../../src/views/StartupComposer.tsx";
import {
  APP_PAINT_MARKER,
  APP_READY_MARKER,
  BOOT_SHELL_MARKER,
  STARTUP_READY_MARKER,
} from "../../tooling/artifact/markers.ts";
import {
  BANNER,
  FIRST_RUN_SPLASH_MIN_COLUMNS,
  FIRST_RUN_SPLASH_MIN_ROWS,
  firstRunSplashFits,
  Splash,
} from "../../src/views/Splash.tsx";

async function frame(width: number, height = 24): Promise<string> {
  const t = await openRender(
    () => (
      <box width={width} height={height}>
        <Splash agent={() => "coder"} model={() => "sonnet-4-5"} width={() => width} />
      </box>
    ),
    { width, height },
  );
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("the splash shows the banner, agent/model line and hints at 80 cols", async () => {
  const out = await frame(80);
  expect(out).toContain(".d8888b.");
  expect(out).toContain("agent: coder · model: sonnet-4-5");
  expect(out).toContain("Type / for commands");
  expect(out).toContain("@ for workspace files");
  expect(out).toContain("Shift+Tab for agents");
});

test("under 60 cols the banner falls back to the one-line wordmark", async () => {
  const out = await frame(50);
  expect(out).not.toContain(".d8888b.");
  expect(out).toContain("C L A R V I S");
});

test("the banner art is 8 rows and fits 60 cols", () => {
  expect(BANNER.length).toBe(8);
  for (const line of BANNER) expect(line.length).toBeLessThan(60);
});

test("first-run splash fit keeps one threshold across setup and catalog pickers", () => {
  expect(firstRunSplashFits(FIRST_RUN_SPLASH_MIN_COLUMNS, FIRST_RUN_SPLASH_MIN_ROWS)).toBe(true);
  expect(firstRunSplashFits(FIRST_RUN_SPLASH_MIN_COLUMNS - 1, FIRST_RUN_SPLASH_MIN_ROWS)).toBe(
    false,
  );
  expect(firstRunSplashFits(FIRST_RUN_SPLASH_MIN_COLUMNS, FIRST_RUN_SPLASH_MIN_ROWS - 1)).toBe(
    false,
  );
});

test("the parser-free boot frame fills the terminal while startup modules load", async () => {
  const t = await openRender(() => <BootFrame />, { width: 48, height: 12 });
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain(BOOT_SHELL_MARKER);
  expect(out).toContain("/  C L A R V I S");
  expect(out).toContain("loading workspace");
  expect(out).toContain("Preparing composer…");
  expect(out).not.toContain(APP_PAINT_MARKER);
  expect(out).not.toContain(APP_READY_MARKER);
  for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(48);
  t.renderer.destroy();
});

test("the boot frame drops decorative identity before it competes with the compact loader", async () => {
  const t = await openRender(() => <BootFrame />, { width: 24, height: 6 });
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).not.toContain("C L A R V I S");
  expect(out).toContain("loading workspace");
  for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(24);
  t.renderer.destroy();
});

test("the startup composer paints honest readiness markers and queues an early task", async () => {
  const state = createStartupComposerState();
  const t = await openRender(() => <StartupComposer state={state} acceptsInput />, {
    width: 72,
    height: 16,
  });
  await t.renderOnce();
  const first = t.captureCharFrame();
  expect(first).toContain(BOOT_SHELL_MARKER);
  expect(first).toContain(STARTUP_READY_MARKER);
  expect(first).toContain(".d8888b.");
  expect(first).not.toContain(APP_PAINT_MARKER);
  expect(first).not.toContain(APP_READY_MARKER);
  expect(first).toContain("Type now; Enter queues the task");

  await t.mockInput.typeText("inspect plugin startup");
  t.mockInput.pressEnter();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("task queued");
  expect(state.take()).toEqual({
    draft: "inspect plugin startup",
    submission: "inspect plugin startup",
  });
  t.renderer.destroy();
});

test("the startup composer shares the responsive Clarvis splash on first paint", async () => {
  const complete = await openRender(
    () => <StartupComposer state={createStartupComposerState()} acceptsInput />,
    { width: 60, height: 16 },
  );
  await complete.renderOnce();
  expect(complete.captureCharFrame()).toContain(".d8888b.");
  complete.renderer.destroy();

  const short = await openRender(
    () => <StartupComposer state={createStartupComposerState()} acceptsInput />,
    { width: 60, height: 15 },
  );
  await short.renderOnce();
  const shortFrame = short.captureCharFrame();
  expect(shortFrame).not.toContain(".d8888b.");
  expect(shortFrame).toContain("C L A R V I S");
  short.renderer.destroy();

  const narrow = await openRender(
    () => <StartupComposer state={createStartupComposerState()} acceptsInput />,
    { width: 59, height: 16 },
  );
  await narrow.renderOnce();
  const narrowFrame = narrow.captureCharFrame();
  expect(narrowFrame).not.toContain(".d8888b.");
  expect(narrowFrame).toContain("C L A R V I S");
  narrow.renderer.destroy();
});

test("the startup composer preserves an unsent draft and keeps resume locked", async () => {
  const draftState = createStartupComposerState();
  const draft = await openRender(() => <StartupComposer state={draftState} acceptsInput />, {
    width: 60,
    height: 12,
  });
  await draft.renderOnce();
  await draft.mockInput.typeText("keep this draft");
  await draft.renderOnce();
  expect(draftState.take()).toEqual({ draft: "keep this draft" });
  draft.renderer.destroy();

  const resume = await openRender(
    () => <StartupComposer state={createStartupComposerState()} acceptsInput={false} />,
    { width: 60, height: 12 },
  );
  await resume.renderOnce();
  const frame = resume.captureCharFrame();
  expect(frame).toContain("Restoring session");
  expect(frame).not.toContain(APP_READY_MARKER);
  resume.renderer.destroy();
});

test("startup handoff submits only to a runnable Agent Profile and otherwise restores exact input", () => {
  const queued = { draft: "queued task", submission: "queued task" };
  expect(resolveStartupComposerHandoff(queued, true)).toEqual({ submission: "queued task" });
  expect(resolveStartupComposerHandoff(queued, false)).toEqual({ initialDraft: "queued task" });
  expect(resolveStartupComposerHandoff({ draft: "unsent draft" }, false)).toEqual({
    initialDraft: "unsent draft",
  });
  expect(resolveStartupComposerHandoff({ draft: "" }, false)).toEqual({});
});
