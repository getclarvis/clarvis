import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { DEFAULT_SHARED_AGENT_PROMPT, renderSharedPromptDocument } from "@clarvis/loop/host";
import { createConfigService } from "../../src/config/config-service.ts";
import { createFileConfigStore } from "../../src/config/file-config-store.ts";
import { createMemoryConfigStore } from "../../src/config/memory-config-store.ts";
import { createSettingsRunAssembler } from "../../src/runs/settings-assembler.ts";

const REPLACE = (body: string) => renderSharedPromptDocument("replace", body);

function assemblerOf(store: ReturnType<typeof createMemoryConfigStore>) {
  return createSettingsRunAssembler(store, { defaultModel: "openrouter/m" });
}

describe("shared prompt resolution", () => {
  it("stamps the built-in default onto a run with no override", () => {
    const store = createMemoryConfigStore();
    const body = assemblerOf(store)({
      execution_id: "builtin",
      agent: "marshall",
      messages: [],
    }) as {
      shared_prompt?: string;
    };
    expect(body.shared_prompt).toBe(DEFAULT_SHARED_AGENT_PROMPT);
  });

  it("prefers workspace over global over builtin", async () => {
    const store = createMemoryConfigStore({
      sharedPrompts: { global: REPLACE("Global policy.") },
    });
    const config = createConfigService(store);
    await config.writeSharedPrompt("workspace", { mode: "replace", body: "Workspace policy." });
    const body = assemblerOf(store)({
      execution_id: "workspace",
      agent: "marshall",
      messages: [],
    }) as {
      shared_prompt?: string;
    };
    expect(body.shared_prompt).toBe("Workspace policy.");
    expect((await config.getSharedPrompt()).source).toBe("workspace");
  });

  it("honours replace, disabled, and reset/inheritance", async () => {
    const store = createMemoryConfigStore({
      sharedPrompts: { global: REPLACE("Global policy.") },
    });
    const config = createConfigService(store);
    expect((await config.getSharedPrompt()).prompt).toBe("Global policy.");

    await config.writeSharedPrompt("global", { mode: "disabled", body: "" });
    const disabled = assemblerOf(store)({
      execution_id: "disabled",
      agent: "marshall",
      messages: [],
    }) as {
      shared_prompt?: string;
    };
    expect(disabled.shared_prompt).toBe("");
    expect((await config.getSharedPrompt()).source).toBe("disabled");

    await config.deleteSharedPrompt("global");
    const inherited = assemblerOf(store)({
      execution_id: "inherited",
      agent: "marshall",
      messages: [],
    }) as {
      shared_prompt?: string;
    };
    expect(inherited.shared_prompt).toBe(DEFAULT_SHARED_AGENT_PROMPT);
    expect((await config.getSharedPrompt()).source).toBe("builtin");
  });

  it("skips an invalid override whole and reports the diagnostic", async () => {
    const store = createMemoryConfigStore({
      sharedPrompts: { global: "---\nmode: replace\n---\n\n" },
    });
    const config = createConfigService(store);
    const view = await config.getSharedPrompt();
    expect(view.source).toBe("builtin");
    expect(view.layers.global.status).toBe("rejected");
    expect(view.diagnostics[0]?.reason).toBe("replace requires a non-empty body");
    expect(
      (
        assemblerOf(store)({ execution_id: "invalid", agent: "marshall", messages: [] }) as {
          shared_prompt?: string;
        }
      ).shared_prompt,
    ).toBe(DEFAULT_SHARED_AGENT_PROMPT);
  });

  it("does not inject an untrusted workspace shared prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-shared-trust-"));
    const globalDir = join(root, "global");
    mkdirSync(join(root, ".clarvis"), { recursive: true });
    writeFileSync(join(root, ".clarvis", "shared-agent.md"), REPLACE("Repo policy."));
    const store = createFileConfigStore({ workspaceRoot: root, globalDir });
    const config = createConfigService(store);
    const view = await config.getSharedPrompt();
    expect(view.source).toBe("builtin");
    expect(view.layers.workspace?.status).toBe("rejected");
    expect(view.layers.workspace?.reason).toBe("workspace is not trusted");
    expect((await config.getSettings()).workspace_trust?.state).toBe("unapproved");
  });

  it("uses the workspace override after approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-shared-trust-ok-"));
    const globalDir = join(root, "global");
    mkdirSync(join(root, ".clarvis"), { recursive: true });
    writeFileSync(join(root, ".clarvis", "shared-agent.md"), REPLACE("Repo policy."));
    const store = createFileConfigStore({ workspaceRoot: root, globalDir });
    const config = createConfigService(store);
    await config.approveWorkspace();
    const view = await config.getSharedPrompt();
    expect(view.source).toBe("workspace");
    expect(view.prompt).toBe("Repo policy.");
  });

  it("keeps a stamped request unchanged when the file later changes", async () => {
    const store = createMemoryConfigStore({
      sharedPrompts: { global: REPLACE("First.") },
    });
    const first = assemblerOf(store)({
      execution_id: "first",
      agent: "marshall",
      messages: [],
    }) as {
      shared_prompt?: string;
    };
    store.writeSharedPrompt("global", REPLACE("Second."));
    expect(first.shared_prompt).toBe("First.");
    const second = assemblerOf(store)({
      execution_id: "second",
      agent: "marshall",
      messages: [],
    }) as {
      shared_prompt?: string;
    };
    expect(second.shared_prompt).toBe("Second.");
  });

  it("an overlay replaces only the profile prompt, not the shared layer", async () => {
    const store = createMemoryConfigStore({
      sharedPrompts: { global: REPLACE("Fleet policy.") },
    });
    const config = createConfigService(store);
    await config.writeAgent("global", "marshall", {
      frontmatter: {},
      body: "Custom marshall.",
    });
    const body = assemblerOf(store)({
      execution_id: "overlay",
      agent: "marshall",
      messages: [],
    }) as {
      shared_prompt?: string;
      profiles: Array<{ name: string; base_prompt?: string }>;
    };
    expect(body.shared_prompt).toBe("Fleet policy.");
    expect(body.profiles.find((p) => p.name === "marshall")?.base_prompt).toContain(
      "Custom marshall.",
    );
  });

  it("a user-created agent still inherits the shared prompt", async () => {
    const store = createMemoryConfigStore({
      sharedPrompts: { global: REPLACE("Fleet policy.") },
    });
    const config = createConfigService(store);
    await config.writeAgent("global", "mine", {
      frontmatter: { grants: ["read_workspace"] },
      body: "I am mine.",
    });
    const body = assemblerOf(store)({ execution_id: "custom", agent: "mine", messages: [] }) as {
      shared_prompt?: string;
      profiles: Array<{ name: string; base_prompt?: string }>;
    };
    expect(body.shared_prompt).toBe("Fleet policy.");
    expect(body.profiles[0]?.base_prompt).toContain("I am mine.");
  });
});
