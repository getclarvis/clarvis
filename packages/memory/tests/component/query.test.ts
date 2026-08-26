import { beforeEach, describe, expect, test } from "bun:test";

import { queryMemory } from "../../src/query.ts";
import { rankByOverlap } from "../../src/similar.ts";
import { createInMemoryMemoryStore } from "../../src/testing.ts";
import type { MemoryStore } from "../../src/types.ts";

/** A small bilingual wiki, written the way the indexer writes one. */
const CORPUS: Record<string, string> = {
  "PROFILE.md":
    "---\ndescription: Workspace operational profile\ntags: [profile]\n---\n" +
    "# Operational profile\n\nA Bun monorepo. Follow the links to drill down.\n",
  "infra/TOPIC.md":
    "---\ndescription: Runtime, builds and deployment\ntags: [infra]\n---\n" +
    "# Infrastructure\n\nRuntime and deployment knowledge.\n",
  "infra/bun/MEMORY.md":
    "---\ndescription: Bun runtime and how it is pinned\ntags: [bun, mise, runtime]\n---\n" +
    "# Bun\n\nBun is pinned to 1.3.14 via mise.\nRun `bun install` from the repository root only.\n" +
    "The lockfile is committed at the root.\n",
  "infra/deploy/MEMORY.md":
    "---\ndescription: Deploying the service to production\ntags: [deploy, fly]\n---\n" +
    "# Deploy\n\nDeployment runs through a release workflow.\nRoll back with the previous release tag.\n",
  "testing/e2e/MEMORY.md":
    "---\ndescription: Driving the terminal UI headlessly\ntags: [tmux, e2e]\n---\n" +
    "# End to end\n\nThe terminal UI refuses to start without a real terminal.\n" +
    "Drive it with tmux send-keys and read it with capture-pane.\n",
  "produto/faturamento/MEMORY.md":
    "---\ndescription: Configuração de cobrança recorrente\ntags: [faturamento, cobranca]\n---\n" +
    "# Faturamento\n\nA configuração de cobrança recorrente fica no painel de faturamento.\n" +
    "O ciclo de cobrança é mensal e a fatura é emitida no primeiro dia.\n",
  "produto/onboarding/MEMORY.md":
    "---\ndescription: Fluxo de onboarding de novos usuários\ntags: [onboarding, produto]\n---\n" +
    "# Onboarding\n\nO fluxo de onboarding cria a conta e envia o email de boas-vindas.\n",
};

async function seedCorpus(store: MemoryStore): Promise<void> {
  for (const [path, content] of Object.entries(CORPUS)) await store.write(path, content);
}

describe("queryMemory", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = createInMemoryMemoryStore();
    await seedCorpus(store);
  });

  const ask = (query: string, input: Record<string, unknown> = {}) =>
    queryMemory({ tx: store, input: { query, ...input } });

  test("ranks the document that actually answers the question first", async () => {
    expect((await ask("how is bun pinned")).hits[0]?.path).toBe("infra/bun/MEMORY.md");
    expect((await ask("drive the terminal ui headlessly")).hits[0]?.path).toBe(
      "testing/e2e/MEMORY.md",
    );
    expect((await ask("rolling back a deployment")).hits[0]?.path).toBe("infra/deploy/MEMORY.md");
  });

  test("finds accented Portuguese from an unaccented query", async () => {
    // How a Brazilian user actually types on a US keyboard.
    const hit = (await ask("configuracao de cobranca recorrente")).hits[0];
    expect(hit?.path).toBe("produto/faturamento/MEMORY.md");
  });

  test("finds the same document however the accents are typed", async () => {
    const accented = await ask("configuração de cobrança");
    const plain = await ask("configuracao de cobranca");
    expect(accented.hits.map((h) => h.path)).toEqual(plain.hits.map((h) => h.path));
  });

  test("returns nothing for a query with no searchable terms", async () => {
    // "the of and" is not a request for the entire wiki.
    const result = await ask("the of and de para");
    expect(result.terms).toEqual([]);
    expect(result.hits).toEqual([]);
  });

  test("returns nothing rather than noise when the wiki does not cover it", async () => {
    expect((await ask("kubernetes ingress certificates")).hits).toEqual([]);
  });

  test("reports which fields matched, in canonical order", async () => {
    const hit = (await ask("mise")).hits[0];
    expect(hit?.matched_fields).toContain("tags");
    expect(hit?.matched_fields).toEqual(
      [...hit!.matched_fields].sort(
        (a, b) =>
          ["title", "description", "tags", "path", "body"].indexOf(a) -
          ["title", "description", "tags", "path", "body"].indexOf(b),
      ),
    );
  });

  test("excerpts the part of the body that matched, not the opening", async () => {
    const hit = (await ask("lockfile committed root")).hits[0];
    expect(hit?.snippet).toContain("lockfile");
    expect(hit?.snippet_line).toBeGreaterThan(0);
  });

  test("omits snippets when the caller does not want them", async () => {
    const hit = (await ask("bun mise", { include_snippets: false })).hits[0];
    expect(hit?.snippet).toBe("");
    expect(hit?.snippet_line).toBeNull();
  });

  test("scanned counts what was read; listed counts what the filters allowed", async () => {
    // The two used to be one field: `listed`'s meaning on the no-terms path and
    // `scanned`'s everywhere else, so the number could not be compared across
    // two queries.
    const empty = await ask("   ");
    expect(empty.terms).toEqual([]);
    expect(empty.scanned).toBe(0);
    expect(empty.listed).toBe(Object.keys(CORPUS).length);

    const scoped = await ask("cobranca", { prefix: "infra/" });
    expect(scoped.listed).toBe(3);
    expect(scoped.scanned).toBe(scoped.listed);
  });

  test("filters by path prefix and by kind", async () => {
    const scoped = await ask("cobranca", { prefix: "infra/" });
    expect(scoped.hits).toEqual([]);
    // infra/TOPIC.md, infra/bun/MEMORY.md, infra/deploy/MEMORY.md
    expect(scoped.scanned).toBe(3);

    const leaves = await ask("deployment", { kinds: ["memory"] });
    expect(leaves.hits.every((h) => h.kind === "memory")).toBe(true);
  });

  test("honours the limit and clamps it", async () => {
    expect((await ask("bun mise deploy onboarding", { limit: 2 })).hits).toHaveLength(2);
    expect((await ask("bun", { limit: 999 })).hits.length).toBeLessThanOrEqual(20);
  });

  test("is stable: the same corpus and query rank identically every time", async () => {
    const once = (await ask("deployment release")).hits.map((h) => `${h.path}:${String(h.score)}`);
    for (let i = 0; i < 20; i++) {
      expect(
        (await ask("deployment release")).hits.map((h) => `${h.path}:${String(h.score)}`),
      ).toEqual(once);
    }
  });

  test("does not depend on the order documents were written", async () => {
    const reversed = createInMemoryMemoryStore();
    for (const [path, content] of Object.entries(CORPUS).reverse()) {
      await reversed.write(path, content);
    }
    const a = (await ask("bun mise runtime")).hits.map((h) => h.path);
    const b = (await queryMemory({ tx: reversed, input: { query: "bun mise runtime" } })).hits.map(
      (h) => h.path,
    );
    expect(b).toEqual(a);
  });

  test("bounds document count and reads through the pre-materialization byte seam", async () => {
    const boundedReads: Array<{ path: string; maxBytes: number }> = [];
    const summaries = await store.list();
    const tx = {
      list: async () => summaries,
      read: async () => {
        throw new Error("unbounded read should not be used");
      },
      readBounded: async (path: string, maxBytes: number) => {
        boundedReads.push({ path, maxBytes });
        const raw = await store.read(path);
        return raw === null ? null : { text: raw.slice(0, maxBytes), truncated: false };
      },
    };

    const result = await queryMemory({
      tx,
      input: { query: "runtime deployment" },
      config: { maxDocuments: 2, maxDocumentBytes: 128 },
    });

    expect(result.scanned).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.truncation_reasons).toContain("documents");
    expect(boundedReads).toHaveLength(2);
    expect(boundedReads.every((read) => read.maxBytes === 128)).toBe(true);
  });

  test("stops accumulating candidates at the corpus byte budget", async () => {
    const result = await queryMemory({
      tx: store,
      input: { query: "runtime deployment onboarding" },
      config: { maxCorpusBytes: 180, maxDocumentBytes: 10_000 },
    });

    expect(result.truncated).toBe(true);
    expect(result.truncation_reasons).toContain("corpus_bytes");
    expect(result.scanned).toBeLessThan(Object.keys(CORPUS).length);
  });

  test("bounds the fallback read path at a UTF-8 boundary and clips a late snippet", async () => {
    const raw =
      "---\ndescription: alpha runtime\n---\n# Alpha\nopening\nmore opening\nalpha é extensively documented here\n";
    const summary = {
      path: "alpha/MEMORY.md",
      kind: "memory" as const,
      description: "alpha runtime",
      tags: [],
      updated_at: 1,
    };
    const result = await queryMemory({
      tx: {
        list: async () => [summary],
        read: async () => raw,
      },
      input: { query: "extensively" },
      config: {
        maxDocumentBytes: Buffer.byteLength(raw, "utf8") - 1,
        snippetChars: 8,
        snippetLines: 1,
      },
    });

    expect(result.truncation_reasons).toContain("document_bytes");
    expect(result.hits[0]?.snippet).toStartWith("…");
    expect(result.hits[0]?.snippet).toEndWith("…");
    expect(result.hits[0]?.snippet_line).toBeGreaterThan(1);
  });

  test("skips vanished documents and reports a truncated bounded read only once", async () => {
    const summaries = (await store.list()).slice(0, 3);
    let reads = 0;
    const result = await queryMemory({
      tx: {
        list: async () => summaries,
        read: async () => null,
        readBounded: async (path) => {
          reads += 1;
          if (reads === 1) return null;
          const raw = await store.read(path);
          return raw === null ? null : { text: raw, truncated: true };
        },
      },
      input: { query: "runtime" },
    });

    expect(result.scanned).toBe(2);
    expect(result.truncation_reasons?.filter((reason) => reason === "document_bytes")).toHaveLength(
      1,
    );
  });

  test("breaks exact lexical ties by detail kind and then path", async () => {
    const paths = ["PROFILE.md", "infra/TOPIC.md", "infra/a/MEMORY.md", "infra/b/MEMORY.md"];
    const raw = "---\ndescription: same\n---\n# Same\nshared term\n";
    const result = await queryMemory({
      tx: {
        list: async () =>
          paths.map((path) => ({
            path,
            kind:
              path === "PROFILE.md" ? "profile" : path.endsWith("TOPIC.md") ? "topic" : "memory",
            description: "same",
            tags: [],
            updated_at: 1,
          })),
        read: async () => raw,
      },
      input: { query: "shared", limit: 4 },
    });

    expect(result.hits.map((hit) => hit.path)).toEqual([
      "infra/a/MEMORY.md",
      "infra/b/MEMORY.md",
      "infra/TOPIC.md",
      "PROFILE.md",
    ]);
  });
});

describe("metadata adjustment", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = createInMemoryMemoryStore();
  });

  const doc = (body: string, front = ""): string =>
    `---\ndescription: d\n${front}---\n# T\n${body}\n`;

  test("cannot surface a document that did not match at all", async () => {
    await store.write("a/pinned/MEMORY.md", doc("nothing relevant here", "pinned: true\n"));
    await store.write("a/other/MEMORY.md", doc("kubernetes ingress"));

    const hits = (await queryMemory({ tx: store, input: { query: "kubernetes" } })).hits;

    expect(hits.map((h) => h.path)).toEqual(["a/other/MEMORY.md"]);
  });

  test("cannot let a much weaker match win on being pinned", async () => {
    // The clamp guarantees a document must score at least 64% of its rival
    // lexically before metadata can reorder them.
    await store.write("a/weak/MEMORY.md", doc("deploy", "pinned: true\nauthority: confirmed\n"));
    await store.write(
      "a/strong/MEMORY.md",
      doc("deploy deploy deploy deployment deployment release rollback"),
    );

    const hits = (await queryMemory({ tx: store, input: { query: "deploy deployment release" } }))
      .hits;

    expect(hits[0]?.path).toBe("a/strong/MEMORY.md");
  });

  test("breaks a genuine tie in favour of the pinned document", async () => {
    const body = "deployment release rollback";
    await store.write("a/plain/MEMORY.md", doc(body));
    await store.write("a/pinned/MEMORY.md", doc(body, "pinned: true\n"));

    const hits = (await queryMemory({ tx: store, input: { query: "deployment" } })).hits;

    expect(hits[0]?.path).toBe("a/pinned/MEMORY.md");
    expect(hits[0]?.pinned).toBe(true);
  });
});

describe("ranking quality against the previous behaviour", () => {
  /** What the old selector did: token overlap over path + description + tags. */
  function baselineRank(
    docs: { path: string; description: string; tags: string[] }[],
    query: string,
  ): string[] {
    return rankByOverlap(
      docs,
      query,
      (d) => `${d.path} ${d.description} ${d.tags.join(" ")}`,
      5,
    ).map((d) => d.path);
  }

  const QUERIES: { query: string; want: string }[] = [
    { query: "how is bun pinned", want: "infra/bun/MEMORY.md" },
    { query: "install dependencies from the root", want: "infra/bun/MEMORY.md" },
    { query: "roll back a release", want: "infra/deploy/MEMORY.md" },
    { query: "drive the terminal ui with tmux", want: "testing/e2e/MEMORY.md" },
    { query: "capture-pane readiness", want: "testing/e2e/MEMORY.md" },
    { query: "configuração de cobrança recorrente", want: "produto/faturamento/MEMORY.md" },
    { query: "configuracao de cobranca", want: "produto/faturamento/MEMORY.md" },
    { query: "ciclo de faturamento mensal", want: "produto/faturamento/MEMORY.md" },
    { query: "email de boas vindas", want: "produto/onboarding/MEMORY.md" },
    { query: "fluxo de onboarding", want: "produto/onboarding/MEMORY.md" },
  ];

  test("the overlap baseline deterministically breaks a real tie", () => {
    expect(rankByOverlap(["z/path", "a/path"], "path", (item) => item, 2)).toEqual([
      "a/path",
      "z/path",
    ]);
  });

  test("finds the right document far more often than token overlap did", async () => {
    const store = createInMemoryMemoryStore();
    await seedCorpus(store);
    const docs = (await store.list()).map((d) => ({
      path: d.path,
      description: d.description,
      tags: d.tags,
    }));

    let ranked = 0;
    let baseline = 0;
    for (const { query, want } of QUERIES) {
      const hits = (await queryMemory({ tx: store, input: { query, limit: 3 } })).hits;
      if (hits[0]?.path === want) ranked += 1;
      if (baselineRank(docs, query)[0] === want) baseline += 1;
    }

    // Every assertion here is a pure function of checked-in bytes and pure
    // code — no clock, no disk, no concurrency — so it cannot flake.
    expect(ranked).toBeGreaterThan(baseline);
    expect(ranked / QUERIES.length).toBeGreaterThanOrEqual(0.8);
  });

  test("finds it within the top three essentially always", async () => {
    const store = createInMemoryMemoryStore();
    await seedCorpus(store);

    let within = 0;
    for (const { query, want } of QUERIES) {
      const hits = (await queryMemory({ tx: store, input: { query, limit: 3 } })).hits;
      if (hits.slice(0, 3).some((h) => h.path === want)) within += 1;
    }

    expect(within / QUERIES.length).toBeGreaterThanOrEqual(0.9);
  });

  test("keeps answers compact enough to paste into a prompt", async () => {
    const store = createInMemoryMemoryStore();
    await seedCorpus(store);

    let total = 0;
    for (const { query } of QUERIES) {
      const hits = (await queryMemory({ tx: store, input: { query, limit: 5 } })).hits;
      total += hits.reduce((n, h) => n + h.snippet.length + h.description.length, 0);
    }

    expect(total / QUERIES.length).toBeLessThan(1800);
  });
});
