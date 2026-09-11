import { expect, mock, test } from "bun:test";
import type { JSX } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { openRender } from "../helpers/tracked-render.ts";
import { KeyEvent, type TextareaRenderable } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import type { MessageContent } from "@clarvis/protocol";
import { InputDock, type SlashOutcome } from "../../src/views/InputDock.tsx";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { Platform } from "../../src/adapters/platform.ts";
import { registerWhenField } from "../../src/keys/when-dsl.ts";
import { commandKeyLabel } from "../../src/keys/keyspec.ts";
import { createPromptHistory } from "../../src/core/prompt-history.ts";
import {
  MAX_COMPOSER_IMAGE_BYTES,
  MAX_COMPOSER_IMAGE_TOTAL_BYTES,
  MAX_COMPOSER_IMAGES,
} from "../../src/core/attachments.ts";
import type { CompleteProvider } from "../../src/views/input/autocomplete.ts";

interface Log {
  submitted: MessageContent[];
  slash: { name: string; args: string }[];
  bash: string[];
  notified: string[];
}

interface DockHandle {
  clearAttachments: () => void;
  restoreAttachments: (content: MessageContent) => void;
  popupOpen: () => boolean;
  expanded: () => boolean;
  closeEditor: () => void;
}

function Host(props: {
  log: Log;
  outcome: SlashOutcome;
  providers?: CompleteProvider[];
  onReady: (el: TextareaRenderable) => void;
  onDock?: (dock: DockHandle) => void;
  platform?: Platform;
  targetLabel?: () => string;
  submissionBlocked?: () => string | null;
  keyboardProfile?: "portable" | "enhanced";
  onInteraction?: (interaction: Interaction) => void;
}): JSX.Element {
  const renderer = useRenderer();
  const keymap = createDefaultOpenTuiKeymap(renderer);
  registerWhenField(keymap);
  const interaction = {
    keymap,
    renderer,
    pushOverlayContext: () => {},
    popOverlayContext: () => {},
    keyboardEnvironment: () => ({ profile: props.keyboardProfile ?? "enhanced" }),
  } as unknown as Interaction;
  props.onInteraction?.(interaction);
  return (
    <InputDock
      interaction={interaction}
      renderer={renderer}
      platform={
        props.platform ??
        ({ readClipboardImage: () => Promise.resolve(null) } as unknown as Platform)
      }
      history={createPromptHistory(200, null)}
      providers={props.providers}
      onSubmit={(content) => props.log.submitted.push(content)}
      onSlashCommand={(name, args) => {
        props.log.slash.push({ name, args });
        return props.outcome;
      }}
      onBashCommand={(cmd) => {
        props.log.bash.push(cmd);
        return true;
      }}
      onNotify={(message) => props.log.notified.push(message)}
      submissionBlocked={props.submissionBlocked}
      onReady={props.onReady}
      onDock={props.onDock}
      targetLabel={props.targetLabel}
    />
  );
}

async function mount(
  outcome: SlashOutcome = "handled",
  providers?: CompleteProvider[],
  platform?: Platform,
  targetLabel?: () => string,
  submissionBlocked?: () => string | null,
  keyboardProfile?: "portable" | "enhanced",
) {
  const log: Log = { submitted: [], slash: [], bash: [], notified: [] };
  let el: TextareaRenderable | undefined;
  let dock: DockHandle | undefined;
  let interaction: Interaction | undefined;
  const t = await openRender(
    (() => (
      <Host
        log={log}
        outcome={outcome}
        providers={providers}
        platform={platform}
        targetLabel={targetLabel}
        submissionBlocked={submissionBlocked}
        keyboardProfile={keyboardProfile}
        onReady={(e) => (el = e)}
        onDock={(value) => (dock = value)}
        onInteraction={(value) => (interaction = value)}
      />
    )) as never,
    { width: 100, height: 16 },
  );
  await t.renderOnce();
  const attachBytes = async (bytes: Uint8Array): Promise<void> => {
    t.renderer.keyInput.processPaste(bytes, {
      kind: "binary",
      mimeType: "image/png",
    });
    await t.renderOnce();
  };
  const attach = (): Promise<void> => attachBytes(new Uint8Array([137, 80, 78, 71]));
  const submitText = async (text: string): Promise<void> => {
    el!.setText(text);
    await t.renderOnce();
    t.mockInput.pressEnter();
    await t.renderOnce();
  };
  const attachFromClipboard = (): void => {
    t.renderer.keyInput.emit(
      "keypress",
      new KeyEvent({
        name: "v",
        ctrl: true,
        meta: false,
        shift: false,
        option: false,
        sequence: "v",
        number: false,
        raw: "v",
        eventType: "press",
        source: "raw",
      }),
    );
  };
  const pressKey = (name: string, mods: { ctrl?: boolean; shift?: boolean } = {}): void => {
    t.renderer.keyInput.emit(
      "keypress",
      new KeyEvent({
        name,
        ctrl: mods.ctrl ?? false,
        meta: false,
        shift: mods.shift ?? false,
        option: false,
        sequence: name,
        number: false,
        raw: name,
        eventType: "press",
        source: "raw",
      }),
    );
  };
  return {
    t,
    log,
    el: () => el!,
    dock: () => dock!,
    interaction: () => interaction!,
    attach,
    attachBytes,
    attachFromClipboard,
    pressKey,
    submitText,
  };
}

test("inline composition is height-bounded and the expanded Task editor preserves the draft", async () => {
  const h = await mount();
  const draft = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  h.el().setText(draft);
  await h.t.renderOnce();
  const inlineRows = h.t
    .captureCharFrame()
    .split("\n")
    .filter((row) => row.trim().length > 0);
  expect(inlineRows.length).toBeLessThanOrEqual(5);
  expect(h.t.captureCharFrame()).not.toContain("New task");

  h.pressKey("e", { ctrl: true });
  await h.t.renderOnce();
  expect(h.dock().expanded()).toBe(true);
  expect(h.t.captureCharFrame()).toContain("Task editor");
  expect(h.el().plainText).toBe(draft);

  h.pressKey("escape");
  await h.t.renderOnce();
  expect(h.dock().expanded()).toBe(false);
  expect(h.el().plainText).toBe(draft);
  h.t.renderer.destroy();
});

test("Shift+Enter and Ctrl+J insert newlines without submitting the draft", async () => {
  const h = await mount();
  h.el().setText("first");
  h.el().gotoBufferEnd();

  h.pressKey("return", { shift: true });
  h.pressKey("j", { ctrl: true });
  await h.t.renderOnce();

  expect(h.el().plainText).toBe("first\n\n");
  expect(h.log.submitted).toEqual([]);
  expect(h.log.slash).toEqual([]);
  h.t.renderer.destroy();
});

test("the portable keyboard profile advertises only Ctrl+J for a newline", async () => {
  const h = await mount("handled", undefined, undefined, undefined, undefined, "portable");
  h.el().setText("first");
  h.el().gotoBufferEnd();

  expect(commandKeyLabel(h.interaction().keymap, "prompt.newline")).toBe("^j");
  h.pressKey("j", { ctrl: true });
  await h.t.renderOnce();
  expect(h.el().plainText).toBe("first\n");
  h.t.renderer.destroy();
});

test("a soft-wrapped logical line grows the inline composer and keeps its prefix visible", async () => {
  const h = await mount();
  const draft = "1234567890".repeat(18);
  h.el().setText(draft);
  h.el().gotoBufferEnd();
  await h.t.renderOnce();

  const frame = h.t.captureCharFrame();
  expect(h.el().lineInfo.lineStartCols.length).toBeGreaterThan(1);
  expect(h.el().height).toBeGreaterThan(1);
  expect(frame).toContain(draft.slice(0, 30));
  expect(frame).toContain(draft.slice(-30));
  h.t.renderer.destroy();
});

test("typed Portuguese accents remain intact in the composer", async () => {
  const h = await mount();
  const draft = "ação você pôde avó avô útil";

  await h.t.mockInput.typeText(draft);
  await h.t.renderOnce();

  expect(h.el().plainText).toBe(draft);
  expect(h.t.captureCharFrame()).toContain(draft);
  h.t.renderer.destroy();
});

test("the empty prompt renders each contextual label only once", async () => {
  const newTask = await mount();
  const newTaskFrame = newTask.t.captureCharFrame();

  expect(newTaskFrame.match(/New task/g)).toHaveLength(1);
  newTask.t.renderer.destroy();

  const adjustment = await mount("handled", undefined, undefined, () => "Ask for an adjustment");
  const adjustmentFrame = adjustment.t.captureCharFrame();

  expect(adjustmentFrame.match(/Ask for an adjustment/g)).toHaveLength(1);
  adjustment.t.renderer.destroy();
});

test("Escape closes autocomplete before collapsing the expanded Task editor", async () => {
  const provider: CompleteProvider = {
    id: "agents",
    trigger: "@",
    label: "agents",
    kind: "completion",
    query: () => [{ value: "coder", label: "coder", insert: "coder" }],
  };
  const h = await mount("handled", [provider]);
  h.pressKey("e", { ctrl: true });
  h.el().setText("@");
  await h.t.renderOnce();
  expect(h.dock().expanded()).toBe(true);
  expect(h.dock().popupOpen()).toBe(true);

  h.pressKey("escape");
  await h.t.renderOnce();
  expect(h.dock().popupOpen()).toBe(false);
  expect(h.dock().expanded()).toBe(true);

  h.pressKey("escape");
  await h.t.renderOnce();
  expect(h.dock().expanded()).toBe(false);
  h.t.renderer.destroy();
});

test("repeated clipboard-image commands are ignored while the first read is pending", async () => {
  let resolveImage!: (value: null) => void;
  const readClipboardImage = mock(
    () =>
      new Promise<null>((resolve) => {
        resolveImage = resolve;
      }),
  );
  const h = await mount("handled", undefined, { readClipboardImage } as unknown as Platform);
  h.attachFromClipboard();
  h.attachFromClipboard();
  expect(readClipboardImage).toHaveBeenCalledTimes(1);
  resolveImage(null);
  await Promise.resolve();
  h.t.renderer.destroy();
});

test("a clipboard image is measured from base64 and staged once", async () => {
  const data = Buffer.from([137, 80, 78, 71]).toString("base64");
  const readClipboardImage = mock(() => Promise.resolve({ data, mediaType: "image/png" }));
  const h = await mount("handled", undefined, { readClipboardImage } as unknown as Platform);

  h.attachFromClipboard();
  await Promise.resolve();
  await h.t.renderOnce();
  expect(h.t.captureCharFrame()).toContain("4B");
  expect(h.log.notified).toEqual(["image attached from clipboard"]);

  await h.submitText("inspect");
  expect(h.log.submitted).toEqual([
    [
      { type: "text", text: "inspect" },
      { type: "image", mime: "image/png", data },
    ],
  ]);
  h.t.renderer.destroy();
});

test("a failed asynchronous submission can restore its staged images", async () => {
  const h = await mount();
  const image = { type: "image" as const, mime: "image/png", data: "AA==" };

  h.dock().restoreAttachments([{ type: "text", text: "previous draft" }, image]);
  await h.t.renderOnce();
  expect(h.t.captureCharFrame()).toContain("1B");

  await h.submitText("previous draft");
  expect(h.log.submitted).toEqual([[{ type: "text", text: "previous draft" }, image]]);
  h.t.renderer.destroy();
});

test("a /command with an image pending runs as a command; the attachment stays pending", async () => {
  const h = await mount("handled");
  await h.attach();
  expect(h.t.captureCharFrame()).toContain("4B");
  await h.submitText("/help");
  expect(h.log.slash).toEqual([{ name: "help", args: "" }]);
  expect(h.log.submitted).toEqual([]);
  expect(h.el().plainText).toBe("");
  expect(h.t.captureCharFrame()).toContain("4B");
  h.t.renderer.destroy();
});

test("an unknown /command with an image pending blocks: draft kept, nothing sent", async () => {
  const h = await mount("block");
  await h.attach();
  await h.submitText("/nope");
  expect(h.log.slash).toEqual([{ name: "nope", args: "" }]);
  expect(h.log.submitted).toEqual([]);
  expect(h.el().plainText).toBe("/nope");
  h.t.renderer.destroy();
});

test("a !bash line with an image pending runs the local shell, not the model", async () => {
  const h = await mount();
  await h.attach();
  await h.submitText("!ls -la");
  expect(h.log.bash).toEqual(["ls -la"]);
  expect(h.log.submitted).toEqual([]);
  h.t.renderer.destroy();
});

test("an argument-hint popup shows usage but Enter still submits the line", async () => {
  const slashProvider: CompleteProvider = {
    id: "command",
    trigger: "/",
    label: "commands",
    query: () => [],
  };
  const hintProvider: CompleteProvider = {
    id: "args:/deploy",
    trigger: "/deploy",
    label: "/deploy arguments",
    kind: "hint",
    query: () => [{ label: "<env>", detail: "target environment", value: "env" }],
  };
  const h = await mount("handled", [slashProvider, hintProvider]);
  h.el().setText("/deploy prod");
  await h.t.renderOnce();
  const frame = h.t.captureCharFrame();
  expect(frame).toContain("<env>");
  expect(frame).toContain("target environment");
  h.t.mockInput.pressEnter();
  await h.t.renderOnce();
  expect(h.log.slash).toEqual([{ name: "deploy", args: "prod" }]);
  expect(h.el().plainText).toBe("");
  h.t.renderer.destroy();
});

test("an interactive provider still owns Enter while its popup is open", async () => {
  const provider: CompleteProvider = {
    id: "command",
    trigger: "/",
    label: "commands",
    query: () => [{ label: "/deploy", value: "deploy.run", insert: "" }],
  };
  const h = await mount("handled", [provider]);
  h.el().setText("/dep");
  await h.t.renderOnce();
  h.t.mockInput.pressEnter();
  await h.t.renderOnce();
  expect(h.log.slash).toEqual([]);
  expect(h.log.submitted).toEqual([]);
  expect(h.el().plainText).toBe("");
  h.t.renderer.destroy();
});

test("rapid text and Enter accept the live completion instead of the stale browse row", async () => {
  const accepted: string[] = [];
  const provider: CompleteProvider = {
    id: "command",
    trigger: "/",
    label: "commands",
    query: (term) =>
      term === "help"
        ? [{ label: "/help", value: "help.open", insert: "" }]
        : [
            { label: "/clear", value: "session.clear", insert: "" },
            { label: "/help", value: "help.open", insert: "" },
          ],
    onAccept: (item) => accepted.push(item.value),
  };
  const h = await mount("handled", [provider]);

  await h.t.mockInput.typeText("/");
  await h.t.renderOnce();
  void h.t.mockInput.typeText("help");
  h.t.mockInput.pressEnter();
  await h.t.renderOnce();

  expect(accepted).toEqual(["help.open"]);
  expect(h.el().plainText).toBe("");
  h.t.renderer.destroy();
});

test("accepting a slash completion leaves the cursor after the inserted command", async () => {
  const provider: CompleteProvider = {
    id: "command",
    trigger: "/",
    label: "commands",
    query: () => [{ label: "/settings", value: "settings.open", insert: "/settings" }],
  };
  const h = await mount("handled", [provider]);
  h.el().setText("/sett");
  await h.t.renderOnce();
  h.t.mockInput.pressEnter();
  await h.t.renderOnce();

  expect(h.el().plainText).toBe("/settings");
  expect(h.el().logicalCursor).toMatchObject({ row: 0, col: "/settings".length });
  h.t.renderer.destroy();
});

test("plain chat with an image pending submits text + image and clears the attachment", async () => {
  const h = await mount();
  await h.attach();
  await h.submitText("look at this");
  expect(h.log.submitted).toEqual([
    [
      { type: "text", text: "look at this" },
      { type: "image", mime: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") },
    ],
  ]);
  expect(h.t.captureCharFrame()).not.toContain("4B");
  h.t.renderer.destroy();
});

test("a fifth image is refused with a clear limit and never enters the composer", async () => {
  const h = await mount();
  for (let index = 0; index < MAX_COMPOSER_IMAGES + 1; index += 1) await h.attach();

  expect(h.log.notified.at(-1)).toBe(
    `image not attached: at most ${MAX_COMPOSER_IMAGES} images are allowed per message`,
  );
  expect(h.t.captureCharFrame().match(/4B/g)).toHaveLength(MAX_COMPOSER_IMAGES);

  await h.submitText("inspect these");
  expect(h.log.submitted).toHaveLength(1);
  expect(h.log.submitted[0]).toHaveLength(MAX_COMPOSER_IMAGES + 1);
  h.t.renderer.destroy();
});

test("image-looking mentions are not counted until the workspace resolves them", async () => {
  const h = await mount();
  const draft = Array.from(
    { length: MAX_COMPOSER_IMAGES + 1 },
    (_, index) => `@image-${index}.png`,
  ).join(" ");

  await h.submitText(draft);
  expect(h.log.submitted).toEqual([draft]);
  expect(h.el().plainText).toBe("");
  expect(h.log.notified).toEqual([]);
  h.t.renderer.destroy();
});

test("an oversized binary paste is refused before base64 composition", async () => {
  const h = await mount();
  await h.attachBytes(new Uint8Array(MAX_COMPOSER_IMAGE_BYTES + 1));

  expect(h.log.notified).toEqual(["image not attached: 5.0M exceeds the 5.0M per-image limit"]);
  await h.submitText("text remains usable");
  expect(h.log.submitted).toEqual(["text remains usable"]);
  h.t.renderer.destroy();
});

test("the aggregate image budget is enforced before encoding the next paste", async () => {
  const h = await mount();
  const half = MAX_COMPOSER_IMAGE_TOTAL_BYTES / 2;
  await h.attachBytes(new Uint8Array(half));
  await h.attachBytes(new Uint8Array(half));
  await h.attachBytes(new Uint8Array(1));

  expect(h.log.notified.at(-1)).toBe(
    "image not attached: 10.0M would exceed the 10.0M total attachment limit",
  );
  await h.submitText("two images");
  expect(h.log.submitted[0]).toHaveLength(3);
  h.t.renderer.destroy();
});

test("clipboard image reading is skipped when the composer count is already full", async () => {
  const readClipboardImage = mock(() => Promise.resolve(null));
  const h = await mount("handled", undefined, { readClipboardImage } as unknown as Platform);
  for (let index = 0; index < MAX_COMPOSER_IMAGES; index += 1) await h.attach();

  h.attachFromClipboard();
  expect(readClipboardImage).not.toHaveBeenCalled();
  expect(h.log.notified.at(-1)).toBe(
    `image not attached: at most ${MAX_COMPOSER_IMAGES} images are allowed per message`,
  );
  h.t.renderer.destroy();
});

test("an empty binary image paste reports why nothing was attached", async () => {
  const h = await mount();
  await h.attachBytes(new Uint8Array());
  expect(h.log.notified).toEqual(["image not attached: the image is empty"]);
  h.t.renderer.destroy();
});

test("a memory-pressure block preserves ordinary and shell drafts", async () => {
  const h = await mount("handled", undefined, undefined, undefined, () => "recover memory first");
  await h.submitText("keep this draft");
  expect(h.log.submitted).toEqual([]);
  expect(h.el().plainText).toBe("keep this draft");

  await h.submitText("!expensive-command");
  expect(h.log.bash).toEqual([]);
  expect(h.el().plainText).toBe("!expensive-command");
  h.t.renderer.destroy();
});
