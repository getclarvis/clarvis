<script setup lang="ts">
import { computed } from "vue";
import { useData } from "vitepress";

const { lang } = useData();
const copy = computed(() =>
  lang.value === "pt-BR"
    ? {
        agentsDescription:
          "Sobrescreva Marshall, Admiral, Coder, Explorer ou Planner. Mude apenas as instruções ou também escolha modelo, ferramentas, permissões, delegação, budget e compactação.",
        agentsGuide: "Personalize agentes",
        agentsIndex: "01 / Agentes",
        agentsLink: "/pt-BR/guide/agents",
        agentsTitle: "Substitua o prompt-base de qualquer agente integrado.",
        description:
          "O Clarvis traz um modelo operacional completo, mas não prende você às instruções dele. Mantenha os padrões que servem e personalize as camadas compatíveis no escopo global ou do workspace, sem manter um fork.",
        eyebrow: "O diferencial do Clarvis",
        judgeDescription:
          "Uma política global ou do workspace substitui por inteiro o prompt integrado do judge, para que o modelo de revisão siga os seus critérios de permissão, bloqueio e incerteza.",
        judgeGuide: "Configure o judge",
        judgeIndex: "02 / Judge de comandos",
        judgeLink: "/pt-BR/reference/configuration#prompt-and-memory-control",
        judgeTitle: "Escreva a política que revisa comandos.",
        memoryDescription:
          "Adicione orientações editoriais globais e do workspace à indexação da memória e defina um prompt de compactação personalizado para cada agente efetivo.",
        memoryGuide: "Configure memória e compactação",
        memoryIndex: "03 / Memória e compactação",
        memoryLink: "/pt-BR/reference/configuration#prompt-and-memory-control",
        memoryTitle: "Diga à memória o que vale a pena manter.",
        title: "Os prompts que moldam o trabalho pertencem ao operador.",
        workflowDescription:
          "Substitua um workflow integrado pelo nome ou crie o seu. Defina a síntese, os briefs dos líderes, perfis, rodadas, seletores, fan-out e budgets.",
        workflowGuide: "Crie um workflow",
        workflowIndex: "04 / Workflows",
        workflowLink: "/pt-BR/guide/workflows",
        workflowTitle: "Escreva cada brief e síntese de workflow.",
      }
    : {
        agentsDescription:
          "Override Marshall, Admiral, Coder, Explorer, or Planner. Change only the instructions, or also choose the model, tools, grants, delegation, budget, and compaction.",
        agentsGuide: "Customize agents",
        agentsIndex: "01 / Agents",
        agentsLink: "/guide/agents",
        agentsTitle: "Replace any built-in agent's base prompt.",
        description:
          "Clarvis ships a complete operating model without locking you into its instructions. Keep the defaults that fit and customize the supported layers globally or per workspace, without maintaining a fork.",
        eyebrow: "The Clarvis difference",
        judgeDescription:
          "A global or workspace policy replaces the built-in judge prompt as a whole, so the review model follows your criteria for permission, refusal, and uncertainty.",
        judgeGuide: "Configure the judge",
        judgeIndex: "02 / Command judge",
        judgeLink: "/reference/configuration#prompt-and-memory-control",
        judgeTitle: "Write the policy that reviews commands.",
        memoryDescription:
          "Add global and workspace editorial guidance to memory indexing, then set a custom compaction prompt for each effective agent.",
        memoryGuide: "Configure memory and compaction",
        memoryIndex: "03 / Memory and compaction",
        memoryLink: "/reference/configuration#prompt-and-memory-control",
        memoryTitle: "Tell memory what is worth keeping.",
        title: "The prompts that shape the work belong to the operator.",
        workflowDescription:
          "Replace a shipped workflow by name or create your own. Define its synthesis, leader briefs, profiles, rounds, selectors, fan-out, and budgets.",
        workflowGuide: "Build a workflow",
        workflowIndex: "04 / Workflows",
        workflowLink: "/guide/workflows",
        workflowTitle: "Author every workflow brief and synthesis.",
      },
);
</script>

<template>
  <section class="home-ownership" aria-labelledby="operator-owned-behavior">
    <div class="home-ownership__intro">
      <p class="home-eyebrow">{{ copy.eyebrow }}</p>
      <h2 id="operator-owned-behavior">{{ copy.title }}</h2>
      <p>{{ copy.description }}</p>
    </div>

    <div class="home-ownership__list">
      <article>
        <p class="home-ownership__index">{{ copy.agentsIndex }}</p>
        <div>
          <h3>{{ copy.agentsTitle }}</h3>
          <p>{{ copy.agentsDescription }}</p>
          <a class="home-text-link" :href="copy.agentsLink">{{ copy.agentsGuide }}</a>
        </div>
      </article>

      <article>
        <p class="home-ownership__index">{{ copy.judgeIndex }}</p>
        <div>
          <h3>{{ copy.judgeTitle }}</h3>
          <p>{{ copy.judgeDescription }}</p>
          <a class="home-text-link" :href="copy.judgeLink">{{ copy.judgeGuide }}</a>
        </div>
      </article>

      <article>
        <p class="home-ownership__index">{{ copy.memoryIndex }}</p>
        <div>
          <h3>{{ copy.memoryTitle }}</h3>
          <p>{{ copy.memoryDescription }}</p>
          <a class="home-text-link" :href="copy.memoryLink">{{ copy.memoryGuide }}</a>
        </div>
      </article>

      <article>
        <p class="home-ownership__index">{{ copy.workflowIndex }}</p>
        <div>
          <h3>{{ copy.workflowTitle }}</h3>
          <p>{{ copy.workflowDescription }}</p>
          <a class="home-text-link" :href="copy.workflowLink">{{ copy.workflowGuide }}</a>
        </div>
      </article>
    </div>
  </section>
</template>
