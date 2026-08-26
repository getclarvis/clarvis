import { describe, it, expect } from "../bun-test.ts";
import { createToolEffectPort } from "../../src/runtime/tools/tool-effect.ts";
import { TOOL_EFFECT_PORT, createCapabilityServices } from "@clarvis/capability";

/**
 * The classifier a capability gates on instead of on a list of tool names it had
 * to be told. Its `unknown` arm is the load-bearing one: a gate that must refuse
 * "everything that could change the workspace" only holds if a tool nobody
 * classified refuses by construction.
 */
describe("createToolEffectPort", () => {
  const effect = (name: string): string => createToolEffectPort().effect(name);

  it("classifies the engine's own control surface as control", () => {
    for (const name of [
      "submit_result",
      "ask_user",
      "spawn_subagent",
      "delegate_task",
      "agent_list",
      "agent_poll",
      "agent_stop",
      "agent_steer",
      "await_agents",
    ]) {
      expect(effect(name)).toBe("control");
    }
  });

  it("classifies the read-only coding tools as read", () => {
    for (const name of ["read_file", "list_dir", "glob", "grep", "diff", "tree"]) {
      expect(effect(name)).toBe("read");
    }
  });

  it("classifies every other coding tool as mutate, shell and the monitors included", () => {
    for (const name of ["write_file", "edit_file", "apply_patch", "remove", "move"]) {
      expect(effect(name)).toBe("mutate");
    }
    // They observe and mutate through one entry point, so no caller can treat
    // them as safe without running the command first.
    for (const name of ["shell", "monitor_start", "monitor_poll", "monitor_stop"]) {
      expect(effect(name)).toBe("mutate");
    }
  });

  it("classifies anything it was not told about as unknown, never as read", () => {
    // An MCP server's tool: the engine cannot know what it does, so a gate that
    // refuses non-read effects must refuse it. Defaulting to `read` here would
    // turn a closed rule into an open one and nothing would report it.
    expect(effect("github.create_issue")).toBe("unknown");
    expect(effect("")).toBe("unknown");
    expect(effect("read_file ")).toBe("unknown");
  });

  it("classifies a capability's tool as that capability declared it", () => {
    const port = createToolEffectPort({
      load_skill: "control",
      create_plan: "control",
      write_widget: "mutate",
    });
    expect(port.effect("load_skill")).toBe("control");
    expect(port.effect("create_plan")).toBe("control");
    expect(port.effect("write_widget")).toBe("mutate");
    // …and only for the port that was told: another run's classifier is unaffected.
    expect(effect("create_plan")).toBe("unknown");
    expect(effect("load_skill")).toBe("unknown");
  });

  it("reads a name a capability reserved but never classified as unknown", () => {
    // Reservation answers "who owns this name"; classification answers "what
    // does invoking it cost". Deriving the second from the first is what made
    // every reserved name `control` — the one effect that passes a gate whose
    // whole job is refusing anything that could change the workspace.
    const port = createToolEffectPort({});
    expect(port.effect("create_plan")).toBe("unknown");
  });

  it("does not let a capability reclassify a tool the engine owns", () => {
    const port = createToolEffectPort({ shell: "read", read_file: "mutate" });
    expect(port.effect("shell")).toBe("mutate");
    expect(port.effect("read_file")).toBe("read");
  });

  it("round-trips through the run's port registry under its published key", () => {
    const services = createCapabilityServices();
    services.provide(TOOL_EFFECT_PORT, createToolEffectPort({ create_widget: "control" }));
    expect(services.get(TOOL_EFFECT_PORT)?.effect("create_widget")).toBe("control");
    expect(services.get(TOOL_EFFECT_PORT)?.effect("read_file")).toBe("read");
  });
});
