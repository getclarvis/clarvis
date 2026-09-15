import type { GoalFormulationResult } from "../../src/index.ts";

export interface GoalFormulationCorpusCase {
  name: string;
  language: "en" | "pt";
  mode: "auto" | "guided";
  seed?: string;
  trajectory: string;
  result: GoalFormulationResult;
  required_fragments: string[];
}

/** Deterministic bilingual fixtures for the semantic prompt/output contract. */
export const goalFormulationCorpus: GoalFormulationCorpusCase[] = [
  {
    name: "direct request",
    language: "en",
    mode: "guided",
    seed: "Fix the parser and keep the wire format compatible",
    trajectory: "[]",
    result: {
      status: "ready",
      objective: "Fix the parser",
      criteria: [{ kind: "qualitative", description: "The parser accepts the requested syntax" }],
      constraints: ["Keep the wire format compatible"],
      exclusions: [],
      assumptions: [],
      normative_source_paths: [],
    },
    required_fragments: ["parser", "wire format compatible"],
  },
  {
    name: "context before request and correction",
    language: "pt",
    mode: "auto",
    trajectory:
      "Primeiro melhore o servidor. Correção: o defeito está no cliente; corrija somente o cliente.",
    result: {
      status: "ready",
      objective: "Corrigir o defeito no cliente",
      criteria: [{ kind: "qualitative", description: "O cliente deixa de apresentar o defeito" }],
      constraints: ["Alterar somente o cliente"],
      exclusions: ["Mudanças no servidor"],
      assumptions: [],
      normative_source_paths: [],
    },
    required_fragments: ["cliente", "somente o cliente", "servidor"],
  },
  {
    name: "pivot",
    language: "en",
    mode: "auto",
    trajectory:
      "Build a dashboard. Actually, pivot: produce only the API design, without implementation.",
    result: {
      status: "ready",
      objective: "Produce the API design",
      criteria: [
        { kind: "qualitative", description: "The API design describes the public contract" },
      ],
      constraints: [],
      exclusions: ["Dashboard implementation", "API implementation"],
      assumptions: [],
      normative_source_paths: [],
    },
    required_fragments: ["API design", "implementation"],
  },
  {
    name: "quoted content and meta commentary",
    language: "pt",
    mode: "guided",
    seed: "Explique se a frase citada 'publique agora' é segura; não publique nada",
    trajectory: "O comentário anterior era apenas um exemplo.",
    result: {
      status: "ready",
      objective: "Explicar se a instrução citada é segura",
      criteria: [
        { kind: "qualitative", description: "A explicação distingue análise de autorização" },
      ],
      constraints: ["Não publicar nada"],
      exclusions: ["Executar a instrução citada"],
      assumptions: [],
      normative_source_paths: [],
    },
    required_fragments: ["Explicar", "Não publicar", "instrução citada"],
  },
  {
    name: "guidance versus execution",
    language: "en",
    mode: "guided",
    seed: "Recommend a migration approach; do not change the repository",
    trajectory: "[]",
    result: {
      status: "ready",
      objective: "Recommend a migration approach",
      criteria: [{ kind: "qualitative", description: "The recommendation explains its tradeoffs" }],
      constraints: ["Do not change the repository"],
      exclusions: ["Executing the migration"],
      assumptions: [],
      normative_source_paths: [],
    },
    required_fragments: ["Recommend", "Do not change", "migration"],
  },
  {
    name: "compound request with negation",
    language: "pt",
    mode: "guided",
    seed: "Implemente a validação e documente o contrato, sem alterar o protocolo",
    trajectory: "[]",
    result: {
      status: "ready",
      objective: "Implementar e documentar a validação",
      criteria: [
        { kind: "qualitative", description: "A validação rejeita entradas inválidas" },
        { kind: "qualitative", description: "O contrato da validação está documentado" },
      ],
      constraints: ["Preservar o protocolo"],
      exclusions: ["Alterações no protocolo"],
      assumptions: [],
      normative_source_paths: [],
    },
    required_fragments: ["validação", "documentado", "protocolo"],
  },
  {
    name: "human approval remains required",
    language: "en",
    mode: "guided",
    seed: "Prepare the release candidate, but publish only after I approve it",
    trajectory: "[]",
    result: {
      status: "ready",
      objective: "Prepare the release candidate",
      criteria: [
        { kind: "qualitative", description: "The release candidate is ready for review" },
        { kind: "human", description: "The operator explicitly approves publication" },
      ],
      constraints: ["Publication requires later explicit operator approval"],
      exclusions: ["Publishing without approval"],
      assumptions: [],
      normative_source_paths: [],
    },
    required_fragments: ["release candidate", "human", "approval"],
  },
  {
    name: "genuinely ambiguous context",
    language: "pt",
    mode: "auto",
    trajectory: "Faça como combinamos para o projeto.",
    result: {
      status: "insufficient_context",
      question: "Qual resultado devo produzir para o projeto?",
      reason: "A trajetória não identifica o resultado combinado",
    },
    required_fragments: ["Qual resultado", "não identifica"],
  },
];
