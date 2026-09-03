import { expect, test } from "bun:test";
import { composingLabel } from "../../src/views/blocks.tsx";

test("names the action before any argument byte exists", () => {
  // The first tool_input_delta carries chars: 0 -- the provider has named the
  // tool and nothing more. That event is the one that ends the blind window,
  // so it has to render as something.
  expect(composingLabel(0)).toBe("receiving arguments… 0 chars");
});

test("shows cumulative argument progress with a compact character count", () => {
  expect(composingLabel(512)).toBe("receiving arguments… 512 chars");
  expect(composingLabel(1024)).toBe("receiving arguments… 1.0k chars");
  expect(composingLabel(8_704)).toBe("receiving arguments… 8.7k chars");
  expect(composingLabel(48_147)).toBe("receiving arguments… 48k chars");
});

test("marks a closed argument stream as ready without claiming the tool ran", () => {
  expect(composingLabel(48_147, true)).toBe("arguments ready · 48k chars");
});
