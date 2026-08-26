---
layout: home
pageClass: clarvis-home

hero:
  text: Controle os prompts. Acompanhe o trabalho. Mantenha o controle.
  tagline: Um workspace no terminal onde você pode substituir o prompt-base de qualquer agente integrado e do judge de revisão de comandos, definir o prompt de compactação de cada agente, dizer à memória o que vale a pena registrar e escrever cada brief e síntese de workflow sem manter um fork.
  actions:
    - theme: brand
      text: Instalar o Clarvis
      link: "#install-the-beta"
    - theme: alt
      text: Ler o guia
      link: /pt-BR/getting-started
---

<script setup lang="ts">
import HomeInstall from "../.vitepress/theme/components/HomeInstall.vue";
import HomeModels from "../.vitepress/theme/components/HomeModels.vue";
import HomeOwnership from "../.vitepress/theme/components/HomeOwnership.vue";
</script>

<div class="home-principles" aria-label="Princípios do produto Clarvis">
  <span>Prompts sob controle do operador</span>
  <span>Observável por padrão</span>
  <span>Segurança explícita</span>
</div>

<section class="home-product" aria-labelledby="product-preview-title">
  <div class="home-section-intro home-section-intro--split">
    <div>
      <p class="home-eyebrow">A execução completa</p>
      <h2 id="product-preview-title">Acompanhe o trabalho, não apenas a resposta final.</h2>
    </div>
    <p>
      Planos, chamadas de ferramentas, diffs, tarefas delegadas, pressão de contexto e aprovações
      permanecem em uma única superfície operacional enquanto o agente trabalha.
    </p>
  </div>

  <figure class="home-product-preview">
    <div class="home-product-preview__bar">
      <span>Workspace do Clarvis</span>
      <span>Execução autônoma real</span>
    </div>
    <video
      controls
      disablepictureinpicture
      playsinline
      preload="none"
      poster="/media/clarvis-run-poster.webp"
      aria-label="Uma sessão real do Clarvis planejando, editando arquivos, revisando diffs e executando testes"
    >
      <source src="/media/clarvis-run.mp4" type="video/mp4" />
      Seu navegador não consegue reproduzir este vídeo. Como alternativa, você pode
      <a href="/media/clarvis-run.mp4">baixar a gravação da execução do Clarvis</a>.
    </video>
    <figcaption>
      Uma execução real do Clarvis usando Qwen3.8-Max para planejar, implementar, inspecionar falhas
      e verificar o resultado. A gravação foi editada apenas para ajustar o ritmo; a saída do produto
      não foi alterada.
    </figcaption>
  </figure>
</section>

<section class="home-section" aria-labelledby="operating-surface-title">
  <div class="home-section-intro">
    <p class="home-eyebrow">Um modelo operacional deliberado</p>
    <h2 id="operating-surface-title">Um só lugar para orientar, supervisionar e estender.</h2>
    <p>
      O Clarvis mantém o operador próximo do trabalho sem transformar cada execução em uma
      orquestração manual.
    </p>
  </div>

  <div class="home-pillars">
    <article>
      <p class="home-pillar-number">01 / Oriente</p>
      <h3>Comece com um objetivo claro.</h3>
      <p>
        Trabalhe no projeto atual, escolha o agente e o modelo adequados e então conduza ou interrompa
        a execução sem sair do transcript.
      </p>
      <a href="/pt-BR/guide/daily-use">Aprenda a operação diária</a>
    </article>
    <article>
      <p class="home-pillar-number">02 / Supervisione</p>
      <h3>Mantenha a delegação inspecionável.</h3>
      <p>
        Acompanhe planos, subagentes, chamadas de ferramentas, diffs, testes e uso de contexto enquanto
        a responsabilidade permanece explícita.
      </p>
      <a href="/pt-BR/explanation/how-clarvis-works">Entenda o modelo de execução</a>
    </article>
    <article>
      <p class="home-pillar-number">03 / Controle</p>
      <h3>Mude as instruções por trás do trabalho.</h3>
      <p>
        Substitua prompts de agentes e do judge, oriente o que a memória registra, defina a
        compactação por agente e escreva cada brief e síntese de workflow.
      </p>
      <a href="#operator-owned-behavior">Explore as camadas de prompts</a>
    </article>
  </div>
</section>

<HomeOwnership />

<HomeModels />

<HomeInstall />

<section class="home-section home-learning" aria-labelledby="learning-path-title">
  <div class="home-section-intro home-section-intro--split">
    <div>
      <p class="home-eyebrow">Um caminho claro para começar</p>
      <h2 id="learning-path-title">Da primeira sessão a uma operação repetível.</h2>
    </div>
    <p>
      Aprenda os controles na ordem em que precisar deles. Comece com uma tarefa e adicione delegação
      e comportamento reutilizável quando o trabalho exigir.
    </p>
  </div>

  <ol class="home-steps">
    <li>
      <span>01</span>
      <div>
        <h3>Conecte</h3>
        <p>Adicione um provedor, selecione um modelo e configure seus padrões.</p>
        <a href="/pt-BR/guide/providers-and-models">Provedores e modelos</a>
      </div>
    </li>
    <li>
      <span>02</span>
      <div>
        <h3>Defina os limites</h3>
        <p>Escolha a postura de sandbox e revisão para o trabalho que vem a seguir.</p>
        <a href="/pt-BR/guide/safety">Segurança e controle</a>
      </div>
    </li>
    <li>
      <span>03</span>
      <div>
        <h3>Execute e revise</h3>
        <p>Dê uma tarefa ao Clarvis, acompanhe o progresso e intervenha quando necessário.</p>
        <a href="/pt-BR/getting-started">Sua primeira sessão</a>
      </div>
    </li>
    <li>
      <span>04</span>
      <div>
        <h3>Torne o trabalho repetível</h3>
        <p>Codifique práticas comprovadas como agentes, workflows e extensões.</p>
        <a href="/pt-BR/guide/workflows">Crie um workflow</a>
      </div>
    </li>
  </ol>
</section>

<section class="home-closing" aria-labelledby="closing-title">
  <div>
    <p class="home-eyebrow">Comece com trabalho real</p>
    <h2 id="closing-title">Traga um projeto e um objetivo claro.</h2>
  </div>
  <a class="home-closing__action" href="/pt-BR/getting-started">
    Abra o guia da primeira sessão
  </a>
</section>
