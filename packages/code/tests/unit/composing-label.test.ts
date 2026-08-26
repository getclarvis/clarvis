import { expect, test } from "bun:test";
import { composingLabel } from "../../src/views/blocks.tsx";

test("names the action before any argument byte exists", () => {
  // The first tool_input_delta carries chars: 0 -- the provider has named the
  // tool and nothing more. That event is the one that ends the blind window,
  // so it has to render as something.
  expect(composingLabel(0)).toBe("starting…");
});

test("stays stable as arguments stream instead of exposing implementation byte counts", () => {
  expect(composingLabel(512)).toBe("starting…");
  expect(composingLabel(1024)).toBe("starting…");
  expect(composingLabel(8_704)).toBe("starting…");
});
