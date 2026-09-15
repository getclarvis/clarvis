import type { GoalVerificationResult } from "../../src/index.ts";

export interface GoalVerificationCorpusCase {
  id: string;
  locale: "en" | "pt-BR";
  scenario: string;
  expected: GoalVerificationResult;
}

function result(
  verdict: GoalVerificationResult["verdict"],
  failingScope?: "definition" | "objective" | "criterion",
): GoalVerificationResult {
  const assessmentVerdict = (scope: "definition" | "objective" | "criterion") =>
    scope === failingScope
      ? verdict === "inconclusive"
        ? "inconclusive"
        : "unsatisfied"
      : "satisfied";
  return {
    verdict,
    summary:
      verdict === "achieved"
        ? "The requested result is established"
        : "The result is not established",
    assessments: [
      {
        scope: "definition",
        verdict: assessmentVerdict("definition"),
        rationale: "Definition fidelity was evaluated against its authoritative origin",
        evidence_ids: [],
        inspected_paths: [],
      },
      {
        scope: "objective",
        verdict: assessmentVerdict("objective"),
        rationale: "The proposed result was evaluated against the observable objective",
        evidence_ids: [],
        inspected_paths: [],
      },
      {
        scope: "criterion",
        criterion_id: "quality",
        verdict: assessmentVerdict("criterion"),
        rationale: "The qualitative requirement was evaluated independently",
        evidence_ids: [],
        inspected_paths: [],
      },
    ],
  };
}

export const goalVerificationCorpus: GoalVerificationCorpusCase[] = [
  {
    id: "correct-answer-en",
    locale: "en",
    scenario: "Correct observable answer",
    expected: result("achieved"),
  },
  {
    id: "correct-answer-pt",
    locale: "pt-BR",
    scenario: "Resposta observável correta",
    expected: result("achieved"),
  },
  {
    id: "eloquent-incomplete",
    locale: "en",
    scenario: "Eloquent but incomplete answer",
    expected: result("not_achieved", "criterion"),
  },
  {
    id: "plan-only",
    locale: "pt-BR",
    scenario: "Somente um plano para pedido de implementação",
    expected: result("not_achieved", "objective"),
  },
  {
    id: "scope-expansion",
    locale: "en",
    scenario: "Unrequested out-of-scope mutation",
    expected: result("not_achieved", "definition"),
  },
  {
    id: "constraint-violated",
    locale: "pt-BR",
    scenario: "Restrição explícita violada",
    expected: result("not_achieved", "definition"),
  },
  {
    id: "host-pass-quality-missing",
    locale: "en",
    scenario: "Host check passes but qualitative requirement is missing",
    expected: result("not_achieved", "criterion"),
  },
  {
    id: "advice-without-action",
    locale: "pt-BR",
    scenario: "Pedido de aconselhamento respondido sem executar mudança",
    expected: result("achieved"),
  },
  {
    id: "compound-partial",
    locale: "en",
    scenario: "Only part of a compound request is complete",
    expected: result("not_achieved", "criterion"),
  },
  {
    id: "guided-short-spec",
    locale: "pt-BR",
    scenario: "Semente curta aponta para spec integralmente atendida",
    expected: result("achieved"),
  },
  {
    id: "formulation-omission",
    locale: "en",
    scenario: "Guided formulation omitted a material source requirement",
    expected: result("not_achieved", "definition"),
  },
  {
    id: "source-drift",
    locale: "pt-BR",
    scenario: "Fonte normativa mudou depois da criação",
    expected: result("inconclusive", "definition"),
  },
  {
    id: "artifact-drift",
    locale: "en",
    scenario: "Result artifact changed after verifier read",
    expected: result("inconclusive", "objective"),
  },
  {
    id: "candidate-lie",
    locale: "pt-BR",
    scenario: "Candidate contradiz o workspace",
    expected: result("not_achieved", "objective"),
  },
  {
    id: "missing-evidence",
    locale: "en",
    scenario: "Genuine absence of evidence",
    expected: result("inconclusive", "criterion"),
  },
];
