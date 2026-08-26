import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { ChoiceRows } from "../../src/views/overlays/ChoiceRows.tsx";

const WIDTH = 60;

/**
 * A bordered card sized to the terminal, holding a choice list whose longest
 * label is far wider than the card's inner width — the shape an elicitation
 * takes when the model authors a long option.
 */
async function frameWithLongOption(labels: string[]): Promise<string> {
  const ui = (): unknown => (
    <box border borderStyle="rounded" flexDirection="column">
      <ChoiceRows
        choices={labels.map((label, i) => ({
          value: `v${i}`,
          label,
          description: `[${i + 1}]`,
        }))}
        selected={() => 0}
        labelWidth={Math.max(...labels.map((l) => l.length))}
      />
    </box>
  );
  const t = await openRender(ui as never, { width: WIDTH, height: 12 });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

/**
 * `labelWidth` is computed by callers from their longest label, and a
 * fixed-width picker cell was laid out with `flexShrink: 0`, so a long
 * model-authored option made the row wider than the card and its text painted
 * straight through the border. Every row must stay inside the frame.
 */
test("a long choice label is truncated inside the card, not painted through its border", async () => {
  const out = await frameWithLongOption([
    "sim",
    "Sim, aplicar a migração automática e manter os orçamentos duplicados por enquanto",
    "não",
  ]);

  const rows = out.split("\n").filter((r) => r.trim().length > 0);
  for (const row of rows) {
    expect(row.length).toBeLessThanOrEqual(WIDTH);
  }

  // The border must survive on every row it is drawn on: a row that overflowed
  // replaced the closing border cell with option text.
  const bordered = rows.filter((r) => r.trimEnd().startsWith("│"));
  expect(bordered.length).toBeGreaterThan(0);
  for (const row of bordered) {
    expect(row.trimEnd().endsWith("│")).toBe(true);
  }
});

test("a short choice list still renders its labels in full", async () => {
  const out = await frameWithLongOption(["approve", "request_changes", "cancel"]);
  expect(out).toContain("approve");
  expect(out).toContain("request_changes");
  expect(out).toContain("cancel");
});
