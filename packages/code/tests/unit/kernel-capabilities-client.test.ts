/**
 * The capabilities catalog a UI lists is skills, and only skills.
 *
 * @remarks The three answers here are each a claim about the in-process kernel,
 * not a formality. `listTools` is empty because the kernel connects to MCP
 * servers only during a run, so nothing downstream exists at catalog time;
 * `connectionStatus` is always `"connected"` because there is no socket to lose,
 * and a UI that showed "disconnected" would be reporting a link that never
 * existed. The prompt mapping is where a skill's presentation reaches the slash
 * command menu, and every optional field is spread conditionally — a skill
 * without a display name must not acquire an `undefined` one.
 *
 * It sat on `NO_COUNTER_ALLOWLIST` as a grandfathered untested module.
 */
import { describe, expect, it } from "bun:test";
import type { SkillsService } from "@clarvis/protocol";
import { createKernelCapabilitiesClient } from "../../src/adapters/kernel-capabilities-client.ts";

function skillsService(over: Partial<SkillsService> = {}): SkillsService {
  return {
    list: async () => [],
    getPrompt: async () => [],
    ...over,
  } as unknown as SkillsService;
}

describe("createKernelCapabilitiesClient", () => {
  it("lists no tools, because the kernel connects to MCP only during a run", async () => {
    const client = createKernelCapabilitiesClient(skillsService());
    expect(await client.listTools()).toEqual([]);
  });

  it("reports connected, because there is no link that could drop", () => {
    expect(createKernelCapabilitiesClient(skillsService()).connectionStatus()).toBe("connected");
  });

  it("prefers a skill's short description over its full one", async () => {
    const client = createKernelCapabilitiesClient(
      skillsService({
        list: async () =>
          [
            {
              name: "review",
              description: "the long form nobody wants in a menu",
              presentation: { shortDescription: "review a diff", displayName: "Review" },
            },
          ] as never,
      }),
    );

    const [prompt] = await client.listPrompts();
    expect(prompt).toMatchObject({
      name: "review",
      description: "review a diff",
      displayName: "Review",
    });
  });

  it("falls back to the full description and omits absent optional fields entirely", async () => {
    const client = createKernelCapabilitiesClient(
      skillsService({
        list: async () => [{ name: "plain", description: "does a thing" }] as never,
      }),
    );

    const [prompt] = await client.listPrompts();
    expect(prompt).toEqual({ name: "plain", description: "does a thing" });
    expect(Object.hasOwn(prompt!, "displayName")).toBe(false);
    expect(Object.hasOwn(prompt!, "agent")).toBe(false);
    expect(Object.hasOwn(prompt!, "plansMode")).toBe(false);
  });

  it("carries agent, plansMode and arguments through when the skill declares them", async () => {
    const client = createKernelCapabilitiesClient(
      skillsService({
        list: async () =>
          [
            {
              name: "full",
              description: "d",
              agent: "coder",
              plansMode: "review",
              arguments: [{ name: "task", required: true }],
            },
          ] as never,
      }),
    );

    expect((await client.listPrompts())[0]).toMatchObject({
      agent: "coder",
      plansMode: "review",
      arguments: [{ name: "task", required: true }],
    });
  });

  it("passes the task argument through and flattens non-string content to empty", async () => {
    let seen: unknown;
    const client = createKernelCapabilitiesClient(
      skillsService({
        getPrompt: async (name: string, args: unknown) => {
          seen = { name, args };
          return [
            { role: "user", content: "plain text" },
            { role: "assistant", content: { type: "image" } },
          ] as never;
        },
      }),
    );

    const messages = await client.getPrompt("review", { task: "audit the diff" });

    expect(seen).toEqual({ name: "review", args: { task: "audit the diff" } });
    expect(messages).toEqual([
      { role: "user", content: "plain text" },
      { role: "assistant", content: "" },
    ]);
  });
});
