import { describe, it, expect } from "bun:test";

import {
  AGENTS_CAPABILITY_NAME,
  AGENTS_DEFAULTS,
  AGENTS_MAX_TOTAL_BUFFER_BYTES,
  AGENTS_REQUEST_PARAMS,
  AGENTS_SETTINGS_FIELDS,
  agentsSettingsSpec,
} from "../../src/settings.ts";

describe("the agents settings block", () => {
  it("fills every field from the defaults when the block is empty", () => {
    expect(AGENTS_SETTINGS_FIELDS.agents.parse({})).toEqual({ ...AGENTS_DEFAULTS });
  });

  it("is optional, so an absent block stays absent rather than materializing defaults", () => {
    expect(AGENTS_SETTINGS_FIELDS.agents.parse(undefined)).toBeUndefined();
  });

  it("rejects an unknown key rather than ignoring a typo", () => {
    expect(() => AGENTS_SETTINGS_FIELDS.agents.parse({ max_live_agents: 4 })).toThrow();
  });

  it("rejects a non-integer or non-positive bound", () => {
    expect(() => AGENTS_SETTINGS_FIELDS.agents.parse({ buffer_lines: 1.5 })).toThrow();
    expect(() => AGENTS_SETTINGS_FIELDS.agents.parse({ max_live_children: 0 })).toThrow();
    expect(() => AGENTS_SETTINGS_FIELDS.agents.parse({ poll_max_bytes: -1 })).toThrow();
  });

  it("hard-caps the aggregate registry buffer budget at 32 MiB", () => {
    expect(
      AGENTS_SETTINGS_FIELDS.agents.parse({
        max_total_buffer_bytes: AGENTS_MAX_TOTAL_BUFFER_BYTES,
      }),
    ).toMatchObject({ max_total_buffer_bytes: AGENTS_MAX_TOTAL_BUFFER_BYTES });
    expect(() =>
      AGENTS_SETTINGS_FIELDS.agents.parse({
        max_total_buffer_bytes: AGENTS_MAX_TOTAL_BUFFER_BYTES + 1,
      }),
    ).toThrow();
  });

  it("admits zero for the two counters that are allowed to be switched off", () => {
    const parsed = AGENTS_SETTINGS_FIELDS.agents.parse({
      finish_nudges: 0,
      max_consecutive_failed_children: 0,
    });
    expect(parsed).toMatchObject({ finish_nudges: 0, max_consecutive_failed_children: 0 });
  });

  it("fills a partial request param from the same defaults, so the merge is the schema's", () => {
    expect(AGENTS_REQUEST_PARAMS.agents.parse({ max_live_children: 2 })).toEqual({
      ...AGENTS_DEFAULTS,
      max_live_children: 2,
    });
  });

  it("still rejects an unknown key in the request param", () => {
    expect(() => AGENTS_REQUEST_PARAMS.agents.parse({ nope: 1 })).toThrow();
  });

  it("registers under its capability name, last-wins and not plugin-contributable", () => {
    expect(agentsSettingsSpec.key).toBe(AGENTS_CAPABILITY_NAME);
    expect(agentsSettingsSpec.merge).toBe("lastWins");
    expect(agentsSettingsSpec.pluginContributable).toBe(false);
    expect(agentsSettingsSpec.requestParams).toBe(AGENTS_REQUEST_PARAMS);
  });
});
