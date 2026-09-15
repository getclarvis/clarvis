import { expect, test } from "bun:test";
import { applyEvent } from "../../src/adapters/store.ts";
import { transcriptExplorationEvents } from "../helpers/transcript-fixtures.ts";
import { openTranscript, transcriptRenderables } from "../helpers/transcript-render.tsx";

test("transcript workload records comparable streaming and residence measurements", async () => {
  const samples: unknown[] = [];
  const measured = process.env.CLARVIS_TRANSCRIPT_MEASURE === "1";
  for (let sample = -1; sample < 3; sample++) {
    if (measured) Bun.gc(true);
    const fixture = await openTranscript();
    try {
      const times: number[] = [];
      for (let row = 0; row < 120; row++) fixture.store.appendNotice(`ROW_${row}`);
      await fixture.frames();
      const sink = fixture.store.openRun("budget-fixture");
      for (const event of transcriptExplorationEvents(500)) applyEvent(sink, event, "live");
      await fixture.frames();
      for (let frame = 0; frame < 90; frame++) {
        const start = performance.now();
        applyEvent(
          sink,
          {
            type: "text_delta",
            at: frame + 100,
            agent: "lead",
            iteration: 1,
            channel: "text",
            text: " streaming",
            reset: frame === 0,
          },
          "live",
        );
        await fixture.rendered.renderOnce();
        times.push(performance.now() - start);
        if (measured) await Bun.sleep(Math.max(0, 1000 / 30 - (performance.now() - start)));
      }
      times.sort((a, b) => a - b);
      expect(fixture.rendered.captureCharFrame()).toContain("streaming");
      if (sample >= 0)
        samples.push({
          sample,
          p95_ms: times[Math.floor(times.length * 0.95)],
          rss: process.memoryUsage().rss,
          native_owners: transcriptRenderables(fixture.rendered.renderer.root).length,
          content_children: fixture.scrollbox().content.getChildren().length,
        });
    } finally {
      fixture.rendered.renderer.destroy();
    }
  }
  if (measured) console.log(JSON.stringify({ size: "120x32", frames: 90, samples }));
});
