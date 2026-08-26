import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { reindex } from "../../src/reindex.ts";
import { createFileMemoryStore } from "../../src/file-store.ts";
import type { MemoryStore } from "../../src/types.ts";
import { makeRoot } from "../helpers/fs.ts";

describe("reindex", () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let store: MemoryStore;

  beforeEach(async () => {
    ({ root, cleanup } = await makeRoot());
    store = createFileMemoryStore({ root });
  });
  afterEach(() => cleanup());

  test("scaffolds the PROFILE and intermediate TOPIC from a lone leaf", async () => {
    await store.write("infra/bun/MEMORY.md", "---\ndescription: pinned via mise\n---\n# Bun");
    const changed = await reindex(store);

    const profile = await store.read("PROFILE.md");
    const topic = await store.read("infra/TOPIC.md");
    expect(profile).not.toBeNull();
    expect(topic).not.toBeNull();
    expect(changed).toContain("PROFILE.md");
    expect(changed).toContain("infra/TOPIC.md");

    expect(profile).toContain(
      "description: Index of durable operational knowledge for this workspace",
    );
    expect(profile).toContain(
      "Durable workspace knowledge, organized by topic. Follow the links below to drill down.",
    );
    expect(profile).not.toContain("reindex:");
    expect(profile).toContain("[infra](infra/TOPIC.md) — pinned via mise");
    expect(topic).toContain("description: pinned via mise");
    expect(topic).toContain("[bun](bun/MEMORY.md) — pinned via mise");
  });

  test("is idempotent — a second pass changes nothing", async () => {
    await store.write("infra/bun/MEMORY.md", "---\ndescription: d\n---\n# Bun");
    await reindex(store);
    expect(await reindex(store)).toEqual([]);
  });

  test("preserves prose outside the managed block and refreshes links on a new leaf", async () => {
    await store.write("infra/bun/MEMORY.md", "---\ndescription: bun\n---\n# Bun");
    await reindex(store);

    const topic = (await store.read("infra/TOPIC.md")) as string;
    const edited = topic.replace("# Infra", "# Infra\n\nHand-written intro that must survive.");
    await store.write("infra/TOPIC.md", edited);

    await store.write(
      "infra/docker/MEMORY.md",
      "---\ndescription: compose on arm64\n---\n# Docker",
    );
    await reindex(store);

    const after = (await store.read("infra/TOPIC.md")) as string;
    expect(after).toContain("Hand-written intro that must survive.");
    expect(after).toContain("[bun](bun/MEMORY.md) — bun");
    expect(after).toContain("[docker](docker/MEMORY.md) — compose on arm64");
  });

  test("migrates legacy marker blocks and repairs a blank profile description", async () => {
    await store.write(
      "PROFILE.md",
      [
        "---",
        "description:",
        "---",
        "",
        "# Operational profile",
        "",
        "## Contents",
        "",
        "<!-- reindex:begin -->",
        "- [old](old/TOPIC.md) — old",
        "<!-- reindex:end -->",
      ].join("\n"),
    );
    await store.write("architecture/api/MEMORY.md", "---\ndescription: API boundaries\n---\n# API");

    await reindex(store);

    const profile = (await store.read("PROFILE.md")) as string;
    expect(profile).toContain(
      "description: Index of durable operational knowledge for this workspace",
    );
    expect(profile).toContain(
      "Durable workspace knowledge, organized by topic. Follow the links below to drill down.",
    );
    expect(profile).toContain("[architecture](architecture/TOPIC.md)");
    expect(profile).not.toContain("reindex:");
    expect(profile).not.toContain("[old]");
  });

  test("upgrades a weak topic description from its child memory", async () => {
    await store.write(
      "dev/TOPIC.md",
      [
        "---",
        "description: dev",
        "---",
        "",
        "# Dev",
        "",
        "## Contents",
        "",
        "<!-- reindex:begin -->",
        "- [running](running/MEMORY.md)",
        "<!-- reindex:end -->",
      ].join("\n"),
    );
    await store.write(
      "dev/running/MEMORY.md",
      [
        "---",
        "description: How to install, dev-serve, test, and build this Vite personal-finance app",
        "---",
        "",
        "# Running",
      ].join("\n"),
    );

    await reindex(store);

    const topic = (await store.read("dev/TOPIC.md")) as string;
    const profile = (await store.read("PROFILE.md")) as string;
    expect(topic).toContain(
      "description: How to install, dev-serve, test, and build this Vite personal-finance app",
    );
    expect(topic).toContain("Durable knowledge about dev.");
    expect(topic).not.toContain("reindex:");
    expect(profile).toContain(
      "[dev](dev/TOPIC.md) — How to install, dev-serve, test, and build this Vite personal-finance app",
    );
  });

  test("a hand-created leaf with a description is wired in on the next pass", async () => {
    await store.write("testing/e2e/MEMORY.md", "---\ndescription: tmux drives the TUI\n---\n# E2E");
    await reindex(store);
    expect(await store.read("PROFILE.md")).toContain("[testing](testing/TOPIC.md)");
    expect(await store.read("testing/TOPIC.md")).toContain(
      "[e2e](e2e/MEMORY.md) — tmux drives the TUI",
    );
  });

  test("links a leaf without a description as a bare link", async () => {
    await store.write("misc/x/MEMORY.md", "# no frontmatter here");
    await reindex(store);
    const topic = (await store.read("misc/TOPIC.md")) as string;
    expect(topic).toContain("[x](x/MEMORY.md)");
    expect(topic).not.toContain("[x](x/MEMORY.md) —");
  });

  test("keeps a hand-written frontmatter key when repairing a placeholder description", async () => {
    // Regression: repairing a generated placeholder re-serializes the file, and
    // the parser used to drop every key it did not recognize — so a user's own
    // frontmatter was destroyed the first time reindex touched the document.
    await store.write("infra/bun/MEMORY.md", "---\ndescription: pinned via mise\n---\n# Bun");
    await store.write("infra/TOPIC.md", "---\ndescription: infra\nowner: evandro\n---\n# Infra");

    await reindex(store);

    const topic = (await store.read("infra/TOPIC.md")) as string;
    expect(topic).toContain("owner: evandro");
    expect(topic).toContain("description: pinned via mise");
  });

  test("leaves an index file with an unclosed frontmatter block untouched", async () => {
    await store.write("infra/bun/MEMORY.md", "---\ndescription: d\n---\n# Bun");
    const broken = "---\ndescription: half written\n# never closed";
    await store.write("infra/TOPIC.md", broken);

    const changed = await reindex(store);

    expect(changed).not.toContain("infra/TOPIC.md");
    expect(await store.read("infra/TOPIC.md")).toBe(broken);
  });
});
