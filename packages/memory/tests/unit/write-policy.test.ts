import { describe, expect, test } from "bun:test";

import { checkWrite } from "../../src/policy.ts";
import type { DocFrontmatter } from "../../src/types.ts";

describe("write policy", () => {
  const pinned: DocFrontmatter = { description: "d", tags: [], pinned: true };
  const plain: DocFrontmatter = { description: "d", tags: [] };

  test("lets the owner do anything", () => {
    for (const operation of ["replace", "delete"] as const) {
      expect(checkWrite({ intent: "owner", operation, existing: pinned }).allowed).toBe(true);
    }
  });

  test("lets the reindex rewrite a pinned index file", () => {
    // It only ever touches the generated Contents section, never owner prose.
    expect(checkWrite({ intent: "reindex", operation: "replace", existing: pinned }).allowed).toBe(
      true,
    );
  });

  test("refuses to replace or delete pinned content automatically", () => {
    expect(checkWrite({ intent: "indexer", operation: "replace", existing: pinned })).toMatchObject(
      {
        allowed: false,
        code: "pinned_replace",
      },
    );
    expect(
      checkWrite({ intent: "agent_tool", operation: "delete", existing: pinned }),
    ).toMatchObject({ allowed: false, code: "pinned_delete" });
  });

  test("still allows a surgical edit to pinned content", () => {
    // Pinning marks content as the owner's, not as frozen: blocking edits would
    // make a pinned document unmaintainable.
    expect(checkWrite({ intent: "agent_tool", operation: "edit", existing: pinned }).allowed).toBe(
      true,
    );
  });

  test("refuses to let automation grant itself authority", () => {
    expect(
      checkWrite({
        intent: "indexer",
        operation: "replace",
        existing: plain,
        next: { ...plain, pinned: true },
      }),
    ).toMatchObject({ allowed: false, code: "authority_escalation" });
    expect(
      checkWrite({
        intent: "indexer",
        operation: "replace",
        existing: plain,
        next: { ...plain, authority: "confirmed" },
      }),
    ).toMatchObject({ allowed: false, code: "authority_escalation" });
  });

  test("refuses the same escalation from a model-facing tool, not just the indexer", () => {
    // A run steered by content it merely read is no more trusted than the
    // indexer: gating the rule on `intent === "indexer"` let an agent stamp any
    // document pinned + confirmed, which both blocks the indexer from ever
    // correcting it and boosts it in query ranking.
    for (const grant of [{ pinned: true }, { authority: "confirmed" as const }]) {
      expect(
        checkWrite({
          intent: "agent_tool",
          operation: "create",
          existing: null,
          next: { ...plain, ...grant },
        }),
      ).toMatchObject({ allowed: false, code: "authority_escalation" });
      expect(
        checkWrite({
          intent: "agent_tool",
          operation: "replace",
          existing: plain,
          next: { ...plain, ...grant },
        }),
      ).toMatchObject({ allowed: false, code: "authority_escalation" });
    }
  });

  test("refuses to let automation take the owner's pin off", () => {
    // Without this, blocking the grant alone leaves a two-call bypass: edit the
    // `pinned:` line out (an edit to a pinned document is deliberately allowed),
    // then replace the now-unpinned document wholesale.
    expect(
      checkWrite({ intent: "agent_tool", operation: "edit", existing: pinned, next: plain }),
    ).toMatchObject({ allowed: false, code: "authority_revocation" });
    expect(
      checkWrite({ intent: "indexer", operation: "create", existing: pinned, next: plain }),
    ).toMatchObject({ allowed: false, code: "authority_revocation" });
  });

  test("still allows an edit that leaves the pin where it was", () => {
    expect(
      checkWrite({ intent: "agent_tool", operation: "edit", existing: pinned, next: pinned })
        .allowed,
    ).toBe(true);
  });

  test("lets automation keep authority a document already had", () => {
    const confirmed: DocFrontmatter = { description: "d", tags: [], authority: "confirmed" };
    expect(
      checkWrite({
        intent: "indexer",
        operation: "replace",
        existing: confirmed,
        next: confirmed,
      }).allowed,
    ).toBe(true);
  });

  test("lets automation lower authority, which is a ranking signal and not a barrier", () => {
    // Asymmetric on purpose: the pin is a write barrier so it may be neither
    // raised nor removed, while `contested` is the documented way to mark
    // knowledge disputed or believed stale.
    const confirmed: DocFrontmatter = { description: "d", tags: [], authority: "confirmed" };
    for (const authority of ["contested", "observed"] as const) {
      expect(
        checkWrite({
          intent: "agent_tool",
          operation: "replace",
          existing: confirmed,
          next: { ...confirmed, authority },
        }).allowed,
      ).toBe(true);
    }
  });
});
