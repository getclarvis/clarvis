import { expect, test } from "bun:test";
import type { ReviewedEffectClass, ReviewedEffectInference } from "@clarvis/capability";
import type { GuardEffectCallFact as ToolFact } from "@clarvis/tools/guard";
import type { GuardEffectCallFact as ProtocolFact } from "@clarvis/protocol";

type Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

test("standalone tools, leaf capability and protocol retain the same effect discriminators", () => {
  const projection: Equal<ToolFact, ProtocolFact> = true;
  const effectClass: Equal<ToolFact["class"], ReviewedEffectClass> = true;
  const inference: Equal<ToolFact["inference"], ReviewedEffectInference> = true;
  expect([projection, effectClass, inference]).toEqual([true, true, true]);
});
