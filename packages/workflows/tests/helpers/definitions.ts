import type { WorkflowDefinition } from "../../src/artifact.ts";

/** Minimal authored definitions for component tests. The real templates have a
 * single owner in `tests/integration/artifact.test.ts`. */
export const WORKFLOW_DEFINITIONS = [
  {
    name: "audit",
    description: "Audit one subject through discovery, review and verification.",
    args: ["subject"],
    rounds: [
      {
        id: "discover",
        title: "Map audit scope",
        type: "discovery",
        over: { kind: "once" },
        brief: "Map {{args.subject}}.",
        fanout: 1,
      },
      {
        id: "review",
        title: "Review {{item.title}}",
        type: "findings",
        over: { kind: "each", source: "discover.work_items" },
        brief: "Review {{item.goal}}.",
        fanout: 1,
      },
      {
        id: "verify",
        title: "{{item.title}}",
        type: "verdict",
        over: {
          kind: "each",
          source: "review.findings",
          where: { field: "needs_verification" },
        },
        brief: "Refute {{item.claim}}.",
        fanout: 3,
        accept: { kind: "threshold", field: "verdict", value: "refuted", count: 2 },
      },
      {
        id: "gaps",
        title: "Close audit gaps",
        type: "findings",
        over: { kind: "all", source: "review.coverage_gaps" },
        brief: "Close {{item}}.",
        fanout: 1,
        when: "review.coverage_gaps",
      },
    ],
    repeat: {
      rounds: ["review", "verify"],
      until: "no_new",
      dedupe_by: ["claim"],
      dry_rounds: 2,
      max_rounds: 4,
    },
    synthesis: "Report the findings that survived verification.",
    dir: "fixture:audit",
  },
  {
    name: "implement",
    description: "Plan and implement one goal.",
    args: ["goal"],
    rounds: [
      {
        id: "plan",
        title: "Plan implementation",
        type: "discovery",
        over: { kind: "once" },
        brief: "Plan {{args.goal}}.",
        fanout: 1,
      },
    ],
    synthesis: "Report what changed.",
    dir: "fixture:implement",
  },
  {
    name: "research",
    description: "Research one question through independent lines of enquiry.",
    args: ["question"],
    rounds: [
      {
        id: "frame",
        title: "Frame research question",
        type: "discovery",
        over: { kind: "once" },
        brief: "Frame {{args.question}}.",
        fanout: 1,
      },
      {
        id: "investigate",
        title: "{{item.title}}",
        type: "findings",
        over: { kind: "each", source: "frame.work_items" },
        brief: "Investigate {{item.goal}}.",
        fanout: 1,
      },
    ],
    synthesis: "Answer the question.",
    dir: "fixture:research",
  },
] as const satisfies readonly WorkflowDefinition[];
