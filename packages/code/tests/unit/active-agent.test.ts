import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import {
  activeAgentCatalogTransition,
  automaticAgentFallback,
  createActiveAgentStore,
} from "../../src/adapters/active-agent.ts";
import type { ProfileInfo } from "../../src/adapters/run-types.ts";

const profile = (name: string, lead = false): ProfileInfo => ({
  name,
  ...(lead ? { canSpawn: ["worker"] } : {}),
  grants: lead ? ["ask_user"] : ["read_workspace"],
});

test("automatic fallback prefers a runnable marshall over every other Lead", () => {
  const candidates = [
    { name: "runner", isLead: false },
    { name: "alpha", isLead: true },
    { name: "marshall", isLead: true },
  ];
  expect(automaticAgentFallback(candidates)).toBe("marshall");
  // Not merely alphabetical: `alpha` sorts first and is a runnable Lead.
  expect(automaticAgentFallback(candidates, (name) => name !== "marshall")).toBe("alpha");
});

test("without marshall the fallback is the alphabetically first runnable Lead", () => {
  const candidates = [
    { name: "runner", isLead: false },
    { name: "planner", isLead: true },
    { name: "coder", isLead: true },
  ];
  expect(automaticAgentFallback(candidates)).toBe("coder");
  expect(automaticAgentFallback(candidates, (name) => name !== "coder")).toBe("planner");
  expect(
    automaticAgentFallback([
      { name: "zeta", isLead: true },
      { name: "alpha", isLead: true },
    ]),
  ).toBe("alpha");
});

test("marshall wins on name alone; only the fallback branch requires a Lead", () => {
  expect(
    automaticAgentFallback([
      { name: "marshall", isLead: false },
      { name: "coder", isLead: true },
    ]),
  ).toBe("marshall");
  // Runnability, unlike Lead-ness, does gate it.
  expect(
    automaticAgentFallback(
      [
        { name: "marshall", isLead: false },
        { name: "coder", isLead: true },
      ],
      (name) => name !== "marshall",
    ),
  ).toBe("coder");
});

test("automatic fallback never promotes a headless-only fleet", () => {
  expect(
    automaticAgentFallback([
      { name: "runner", isLead: false },
      { name: "explorer", isLead: false },
    ]),
  ).toBe("");
});

test("an invalidated active agent fallback is persisted, but initial resolution is not", () => {
  expect(
    activeAgentCatalogTransition("planner", ["planner", "runner"], () => "runner"),
  ).toBeUndefined();
  expect(activeAgentCatalogTransition("", ["runner"], () => "runner")).toEqual({
    name: "runner",
    persist: false,
  });
  expect(activeAgentCatalogTransition("planner", ["runner"], () => "runner")).toEqual({
    name: "runner",
    persist: true,
  });
  expect(activeAgentCatalogTransition("planner", [], () => "")).toEqual({
    name: "",
    persist: false,
  });
});

test("active agent resolves session, valid default and safe fallback in that order", () => {
  createRoot((dispose) => {
    const [profiles, setProfiles] = createSignal<ProfileInfo[]>([
      profile("runner"),
      profile("planner", true),
      profile("coder", true),
    ]);
    let session: string | undefined = "planner";
    let configured: string | undefined = "runner";
    const persisted: string[] = [];
    const defaults: Array<["global" | "workspace", string]> = [];
    const store = createActiveAgentStore({
      profiles,
      code: {
        agentDefault: () => configured,
        writeAgentDefault: (scope, name) => defaults.push([scope, name]),
      },
      sessionProfile: () => session,
      persistActive: (name) => persisted.push(name),
    });

    expect(store.resolveActive()).toBe("planner");
    expect(store.list().map((candidate) => candidate.name)).toEqual(["coder", "planner", "runner"]);

    session = undefined;
    setProfiles((current) => current.filter((candidate) => candidate.name !== "planner"));
    expect(store.resolveActive()).toBe("runner");

    configured = "missing";
    expect(store.resolveActive()).toBe("coder");

    store.setActive("coder");
    expect(store.active()).toBe("coder");
    expect(persisted).toEqual(["coder"]);
    store.setDefault("planner", "global");
    expect(defaults).toEqual([["global", "planner"]]);
    dispose();
  });
});

test("agent list uses the same canonical presentation order as the Agents window", () => {
  createRoot((dispose) => {
    const store = createActiveAgentStore({
      profiles: () => [
        profile("zeta"),
        profile("planner"),
        profile("marshall", true),
        profile("explorer"),
        profile("coder"),
        profile("admiral", true),
        profile("alpha"),
      ],
      code: { agentDefault: () => undefined, writeAgentDefault: () => {} },
      sessionProfile: () => undefined,
      persistActive: () => {},
    });

    expect(store.list().map((candidate) => candidate.name)).toEqual([
      "marshall",
      "admiral",
      "coder",
      "explorer",
      "planner",
      "alpha",
      "zeta",
    ]);
    dispose();
  });
});

test("an invalid configured default falls back without selecting a sub-agent", () => {
  createRoot((dispose) => {
    const store = createActiveAgentStore({
      profiles: () => [profile("runner"), profile("planner", true), profile("coder", true)],
      code: {
        agentDefault: () => "coder",
        writeAgentDefault: () => {},
      },
      sessionProfile: () => undefined,
      persistActive: () => {},
      isRunnable: (name) => name !== "coder",
    });
    expect(store.resolveActive()).toBe("planner");
    dispose();
  });
});

test("isRunnable is surfaced so a picker can say so before the user chooses", () => {
  createRoot((dispose) => {
    const store = createActiveAgentStore({
      profiles: () => [{ name: "coder" }, { name: "broken" }] as never,
      code: { agentDefault: () => "coder", writeAgentDefault: () => {} },
      sessionProfile: () => undefined,
      persistActive: () => {},
      isRunnable: (name) => name !== "broken",
    });
    expect(store.isRunnable("coder")).toBe(true);
    expect(store.isRunnable("broken")).toBe(false);
    dispose();
  });
});

test("isRunnable defaults to true when the host cannot tell", () => {
  createRoot((dispose) => {
    const store = createActiveAgentStore({
      profiles: () => [{ name: "coder" }] as never,
      code: { agentDefault: () => "coder", writeAgentDefault: () => {} },
      sessionProfile: () => undefined,
      persistActive: () => {},
    });
    expect(store.isRunnable("anything")).toBe(true);
    dispose();
  });
});
