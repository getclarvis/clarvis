import { afterEach, expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { rgbToHex, type RGBA } from "@opentui/core";
import { Footer, HintToast, type FooterStatusTone } from "../../src/views/Footer.tsx";
import { agentGlyph, taskTone } from "../../src/views/blocks.tsx";
import { spinnerChar } from "../../src/views/spinner.ts";
import { tone } from "../../src/theme/tone.ts";
import { tokens } from "../../src/theme/tokens.ts";
import { applyAsciiMode, glyph } from "../../src/theme/glyphs.ts";
import type { HintTone } from "../../src/views/hint.ts";

afterEach(() => applyAsciiMode(false));

test("blocks' status mappers take glyph+color from tone(); domain glyphs (spark, skipped) survive", () => {
  expect(taskTone("done")).toEqual(tone("ok"));
  expect(taskTone("failed")).toEqual(tone("error"));
  expect(taskTone("returned")).toEqual(tone("warn"));
  expect(taskTone("anything-else")).toEqual(tone("pending"));
  expect(taskTone("in_progress").fg).toBe(tokens.accent);
  expect(taskTone("abandoned")).toEqual({ glyph: glyph("skipped"), fg: tokens.muted });

  expect(agentGlyph("ok")).toBe(glyph("spark"));
  expect(agentGlyph("error")).toBe(tone("error").glyph);
  expect(agentGlyph("pending")).toBe(tone("pending").glyph);
});

function fgOf(frame: { lines: { spans: { text: string; fg: RGBA }[] }[] }, needle: string): string {
  for (const line of frame.lines) {
    const span = line.spans.find((s) => s.text.includes(needle));
    if (span) return rgbToHex(span.fg).toLowerCase();
  }
  throw new Error(`no span containing ${JSON.stringify(needle)}`);
}

async function footerFrame(
  hint: { text: string; tone: HintTone },
  status: { text: string; tone: FooterStatusTone },
  navigation?: string,
): Promise<{ lines: { spans: { text: string; fg: RGBA }[] }[] }> {
  const t = await openRender(
    () => (
      <Footer
        hint={() => hint}
        status={() => status}
        navigation={navigation === undefined ? undefined : <text>{navigation}</text>}
      />
    ),
    { width: 70, height: 6 },
  );
  await t.renderOnce();
  const frame = t.captureSpans();
  t.renderer.destroy();
  return frame;
}

function textOf(frame: { lines: { spans: { text: string }[] }[] }): string {
  return frame.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n");
}

test("footer: hint and status agree on the info policy — both render muted, not fg", async () => {
  const frame = await footerFrame(
    { text: "hint-info-text", tone: "info" },
    { text: "status-info-text", tone: "info" },
  );
  expect(fgOf(frame, "hint-info-text")).toBe(tokens.muted.toLowerCase());
  expect(fgOf(frame, "status-info-text")).toBe(tokens.muted.toLowerCase());
});

test("footer: non-info tones keep their semantic colors on both slots", async () => {
  const frame = await footerFrame(
    { text: "hint-error-text", tone: "error" },
    { text: "status-ok-text", tone: "success" },
  );
  expect(fgOf(frame, "hint-error-text")).toBe(tokens.del.toLowerCase());
  expect(fgOf(frame, "status-ok-text")).toBe(tokens.add.toLowerCase());
});

test("footer: the live run line renders spinner in accent, the composed text muted", async () => {
  const frame = await footerFrame(
    { text: "", tone: "info" },
    { text: "Lead → bash(bun test)  ·  12s  ·  1200→345 tok", tone: "running" },
    "",
  );
  expect(fgOf(frame, spinnerChar())).toBe(tokens.accent.toLowerCase());
  expect(fgOf(frame, "12s")).toBe(tokens.muted.toLowerCase());
});

test("the overlay toast speaks the footer's tone language — a warn notify renders warn", async () => {
  const t = await openRender(
    () => <HintToast hint={() => ({ text: "toast-warn-text", tone: "warn" })} />,
    { width: 70, height: 6 },
  );
  await t.renderOnce();
  const frame = t.captureSpans();
  t.renderer.destroy();
  expect(fgOf(frame, "toast-warn-text")).toBe(tokens.warn.toLowerCase());
});

test("footer has no static navigation fallback", async () => {
  const suppressed = await footerFrame({ text: "", tone: "info" }, { text: "", tone: "info" }, "");
  expect(textOf(suppressed)).not.toContain("[/] commands");
  const idle = await footerFrame({ text: "", tone: "info" }, { text: "", tone: "info" });
  expect(textOf(idle)).not.toContain("[/] commands");
});
