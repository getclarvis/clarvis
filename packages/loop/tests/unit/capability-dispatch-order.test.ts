/**
 * Registration order is behaviour, not presentation.
 *
 * @remarks Two mechanisms compose into one guarantee, and neither had a test.
 * `orderCapabilities` sorts a run's capabilities by their declared `order`,
 * preserving registration order among equals; `selectHandler` then dispatches a
 * tool call to the *first* handler that claims it. Together they decide which
 * capability answers a call two of them both match.
 *
 * A host that continues an existing run depends on exactly this: its capability
 * is prepended so its handlers shadow the ones already registered, refusing an
 * inherited tool at dispatch rather than by withholding it — which is what keeps
 * the advertised tool array byte-identical for the provider's prefix cache. A
 * sort that stopped being stable, or a dispatch that started preferring the most
 * specific match, would break that silently and cost a re-billed transcript
 * rather than a red test.
 */
import { describe, expect, it } from "../bun-test.ts";
import type { LLMToolCall, RunCapability } from "@clarvis/capability";
import { orderCapabilities } from "../../src/runtime/capability-order.ts";
import { selectHandler } from "../../src/runtime/loop/loop-contract.ts";
import type { ToolHandler } from "../../src/runtime/loop/loop-contract.ts";

function cap(name: string, order?: number): RunCapability {
  return { name, ...(order === undefined ? {} : { order }) } as RunCapability;
}

const names = (caps: readonly RunCapability[]): string[] => caps.map((c) => c.name);

function handler(
  id: string,
  matches: (call: LLMToolCall) => boolean,
): ToolHandler & { id: string } {
  return {
    id,
    matches,
    handle: () => Promise.resolve({ kind: "result", text: id, progress: false }),
  };
}

const call = (name: string): LLMToolCall => ({ id: "c1", name, arguments: {} });

describe("orderCapabilities", () => {
  it("sorts ascending by declared order", () => {
    const sorted = orderCapabilities([cap("late", 100), cap("early", -100), cap("mid", 0)]);
    expect(names(sorted)).toEqual(["early", "mid", "late"]);
  });

  it("treats an absent order as 0", () => {
    const sorted = orderCapabilities([cap("plain"), cap("first", -1), cap("last", 1)]);
    expect(names(sorted)).toEqual(["first", "plain", "last"]);
  });

  it("keeps registration order among equals, which is the only order a host controls", () => {
    const registered = ["tools", "ask_user", "delegation", "agents", "records", "tasks"];
    const sorted = orderCapabilities(registered.map((n) => cap(n)));
    expect(names(sorted)).toEqual(registered);
  });

  it("keeps registration order among equals that share a non-default order too", () => {
    const sorted = orderCapabilities([
      cap("second", 5),
      cap("third", 5),
      cap("first", -100),
      cap("fourth", 5),
    ]);
    expect(names(sorted)).toEqual(["first", "second", "third", "fourth"]);
  });

  it("does not mutate the caller's array", () => {
    const input = [cap("z", 10), cap("a", -10)];
    orderCapabilities(input);
    expect(names(input)).toEqual(["z", "a"]);
  });

  it("sorts a plans-shaped order: -100 ahead of every default-order capability", () => {
    const sorted = orderCapabilities([
      cap("tools"),
      cap("records"),
      cap("plans", -100),
      cap("agents"),
    ]);
    expect(sorted[0]!.name).toBe("plans");
  });
});

describe("selectHandler", () => {
  it("gives the call to the first handler that claims it, not the most specific", () => {
    const shadowing = handler("shadow", () => true);
    const owner = handler("owner", (c) => c.name === "write_record");

    const picked = selectHandler([shadowing, owner], call("write_record")) as unknown as {
      id: string;
    };
    expect(picked.id).toBe("shadow");
  });

  it("falls through to a later handler when the earlier one declines", () => {
    const narrow = handler("narrow", (c) => c.name === "read_record");
    const owner = handler("owner", (c) => c.name === "write_record");

    const picked = selectHandler([narrow, owner], call("write_record")) as unknown as {
      id: string;
    };
    expect(picked.id).toBe("owner");
  });

  it("returns undefined when nothing claims the call", () => {
    expect(selectHandler([handler("n", () => false)], call("anything"))).toBeUndefined();
    expect(selectHandler([], call("anything"))).toBeUndefined();
  });

  it("composes with the sort: a prepended low-order capability's handler wins", () => {
    const host = { cap: cap("host"), handler: handler("host", () => true) };
    const pass = { cap: cap("pass", -100), handler: handler("pass", () => true) };

    const ordered = orderCapabilities([host.cap, pass.cap]);
    const handlers = ordered.map((c) => (c.name === "pass" ? pass.handler : host.handler));

    const picked = selectHandler(handlers, call("write_record")) as unknown as { id: string };
    expect(picked.id).toBe("pass");
  });
});
