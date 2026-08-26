---
layout: home
pageClass: clarvis-home

hero:
  text: Own the prompts. See the work. Stay in control.
  tagline: A terminal workspace where you can replace any built-in agent's base prompt and the command-review judge, set each agent's compaction prompt, tell memory what is worth recording, and author every workflow brief and synthesis without maintaining a fork.
  actions:
    - theme: brand
      text: Install Clarvis
      link: "#install-the-beta"
    - theme: alt
      text: Read the guide
      link: /getting-started
---

<script setup lang="ts">
import HomeInstall from "./.vitepress/theme/components/HomeInstall.vue";
import HomeModels from "./.vitepress/theme/components/HomeModels.vue";
import HomeOwnership from "./.vitepress/theme/components/HomeOwnership.vue";
</script>

<div class="home-principles" aria-label="Clarvis product principles">
  <span>Operator-owned prompts</span>
  <span>Observable by default</span>
  <span>Explicit safety</span>
</div>

<section class="home-product" aria-labelledby="product-preview-title">
  <div class="home-section-intro home-section-intro--split">
    <div>
      <p class="home-eyebrow">The complete run</p>
      <h2 id="product-preview-title">Follow the work, not just the final answer.</h2>
    </div>
    <p>
      Plans, tool calls, diffs, delegated tasks, context pressure, and approvals remain in one
      operating surface while the agent works.
    </p>
  </div>

  <figure class="home-product-preview">
    <div class="home-product-preview__bar">
      <span>Clarvis workspace</span>
      <span>Real autonomous run</span>
    </div>
    <video
      controls
      disablepictureinpicture
      playsinline
      preload="none"
      poster="/media/clarvis-run-poster.webp"
      aria-label="A real Clarvis session planning, editing files, reviewing diffs, and running tests"
    >
      <source src="/media/clarvis-run.mp4" type="video/mp4" />
      Your browser cannot play this video. You can
      <a href="/media/clarvis-run.mp4">download the Clarvis run</a> instead.
    </video>
    <figcaption>
      A real Clarvis run using Qwen3.8-Max to plan, implement, inspect failures, and verify the
      result. The recording is edited for pace; the product output is unchanged.
    </figcaption>
  </figure>
</section>

<section class="home-section" aria-labelledby="operating-surface-title">
  <div class="home-section-intro">
    <p class="home-eyebrow">A deliberate operating model</p>
    <h2 id="operating-surface-title">One place to direct, supervise, and extend.</h2>
    <p>
      Clarvis keeps the operator close to the work without turning every run into manual
      orchestration.
    </p>
  </div>

  <div class="home-pillars">
    <article>
      <p class="home-pillar-number">01 / Direct</p>
      <h3>Start with a clear objective.</h3>
      <p>
        Work in the current project, choose the right agent and model, then steer or stop the run
        without leaving the transcript.
      </p>
      <a href="/guide/daily-use">Learn daily operation</a>
    </article>
    <article>
      <p class="home-pillar-number">02 / Supervise</p>
      <h3>Keep delegation inspectable.</h3>
      <p>
        Follow plans, sub-agents, tool calls, diffs, tests, and context use while ownership remains
        explicit.
      </p>
      <a href="/explanation/how-clarvis-works">Understand the run model</a>
    </article>
    <article>
      <p class="home-pillar-number">03 / Own</p>
      <h3>Change the instructions behind the work.</h3>
      <p>
        Replace agent and judge prompts, guide what memory records, set compaction per agent, and
        author every workflow brief and synthesis.
      </p>
      <a href="#operator-owned-behavior">Explore the prompt layer</a>
    </article>
  </div>
</section>

<HomeOwnership />

<HomeModels />

<HomeInstall />

<section class="home-section home-learning" aria-labelledby="learning-path-title">
  <div class="home-section-intro home-section-intro--split">
    <div>
      <p class="home-eyebrow">A clear path in</p>
      <h2 id="learning-path-title">From first session to repeatable operation.</h2>
    </div>
    <p>
      Learn the controls in the order you need them. Start with one task, then add delegation and
      reusable behavior when the work calls for it.
    </p>
  </div>

  <ol class="home-steps">
    <li>
      <span>01</span>
      <div>
        <h3>Connect</h3>
        <p>Add a provider, select a model, and set your defaults.</p>
        <a href="/guide/providers-and-models">Providers and models</a>
      </div>
    </li>
    <li>
      <span>02</span>
      <div>
        <h3>Set the boundary</h3>
        <p>Choose the sandbox and review posture for the work ahead.</p>
        <a href="/guide/safety">Safety and control</a>
      </div>
    </li>
    <li>
      <span>03</span>
      <div>
        <h3>Run and review</h3>
        <p>Give Clarvis a task, inspect progress, and steer when needed.</p>
        <a href="/getting-started">Your first session</a>
      </div>
    </li>
    <li>
      <span>04</span>
      <div>
        <h3>Make it repeatable</h3>
        <p>Encode proven work as agents, workflows, and extensions.</p>
        <a href="/guide/workflows">Build a workflow</a>
      </div>
    </li>
  </ol>
</section>

<section class="home-closing" aria-labelledby="closing-title">
  <div>
    <p class="home-eyebrow">Start with real work</p>
    <h2 id="closing-title">Bring one project and one clear objective.</h2>
  </div>
  <a class="home-closing__action" href="/getting-started">Open the first-session guide</a>
</section>
