import { expect, test } from "bun:test";
import { composingLabel } from "../../src/views/blocks.tsx";

test("names the action without claiming byte progress before arguments arrive", () => {
  // The first tool_input_delta carries chars: 0 -- the provider has named the
  // tool and nothing more. That event is the one that ends the blind window,
  // so it has to render as something.
  expect(composingLabel(0)).toBe("waiting for arguments…");
  expect(composingLabel(0, false, 173)).toBe("waiting for arguments… · stream 173 chars");
});

test("shows cumulative argument progress with a compact character count", () => {
  expect(composingLabel(512)).toBe("receiving arguments… 512 chars");
  expect(composingLabel(1024)).toBe("receiving arguments… 1.0k chars");
  expect(composingLabel(8_704)).toBe("receiving arguments… 8.7k chars");
  expect(composingLabel(48_147)).toBe("receiving arguments… 48k chars");
});

test("marks a closed argument stream as ready without claiming the tool ran", () => {
  expect(composingLabel(48_147, true)).toBe("awaiting execution · 48k chars");
  expect(composingLabel(48_147, true, 49_000)).toBe(
    "awaiting execution · 48k chars · stream 49k chars",
  );
});
