<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { useData } from "vitepress";

type Platform = "unix" | "windows";
type ClarvisThemeConfig = {
  productVersion: string;
};

const { lang, theme } = useData<ClarvisThemeConfig>();
const productVersion = computed(() => theme.value.productVersion);
const platforms = ["unix", "windows"] as const;
const copy = computed(() =>
  lang.value === "pt-BR"
    ? {
        beta: "Beta pública",
        copied: "Copiado",
        copyCommand: "Copiar comando",
        copyUnavailable: "Cópia indisponível",
        description:
          "A versão portátil inclui o runtime do Bun e as dependências nativas do terminal. O instalador seleciona sua plataforma, verifica o checksum do arquivo e só ativa o Clarvis depois de confirmar que a CLI preparada informa a versão solicitada.",
        guide: "Veja os detalhes e a opção de inspecionar primeiro",
        guideLink: "/pt-BR/installation",
        platform: "Plataforma de instalação",
        title: "Instale o Clarvis a partir da versão verificada.",
        unix: "Linux (glibc) e macOS",
      }
    : {
        beta: "Public beta",
        copied: "Copied",
        copyCommand: "Copy command",
        copyUnavailable: "Copy unavailable",
        description:
          "The portable release includes its Bun runtime and native terminal dependencies. The installer selects your platform, verifies the archive checksum, and activates Clarvis only after the staged CLI reports the requested version.",
        guide: "See details and the inspect-first option",
        guideLink: "/installation",
        platform: "Installation platform",
        title: "Install Clarvis from the verified release.",
        unix: "Linux (glibc) and macOS",
      },
);
const commands = computed(
  () =>
    ({
      unix: {
        label: copy.value.unix,
        language: "Shell",
        value: `curl -fsSL https://raw.githubusercontent.com/getclarvis/clarvis/v${productVersion.value}/install.sh | sh`,
      },
      windows: {
        label: "Windows",
        language: "PowerShell",
        value: `irm https://raw.githubusercontent.com/getclarvis/clarvis/v${productVersion.value}/install.ps1 | iex`,
      },
    }) as const,
);

const activePlatform = ref<Platform>("unix");
const copyStatus = ref("");
let resetCopyStatus: ReturnType<typeof setTimeout> | undefined;

async function copyCommand(platform: Platform): Promise<void> {
  try {
    await navigator.clipboard.writeText(commands.value[platform].value);
    copyStatus.value = copy.value.copied;
  } catch {
    copyStatus.value = copy.value.copyUnavailable;
  }

  clearTimeout(resetCopyStatus);
  resetCopyStatus = setTimeout(() => {
    copyStatus.value = "";
  }, 2400);
}

function selectPlatform(platform: Platform): void {
  activePlatform.value = platform;
  copyStatus.value = "";
}

async function moveBetweenTabs(event: KeyboardEvent, platform: Platform): Promise<void> {
  const currentIndex = platforms.indexOf(platform);
  let nextIndex: number | undefined;

  if (event.key === "ArrowLeft")
    nextIndex = (currentIndex - 1 + platforms.length) % platforms.length;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % platforms.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = platforms.length - 1;
  if (nextIndex === undefined) return;

  event.preventDefault();
  const nextPlatform = platforms[nextIndex];
  selectPlatform(nextPlatform);
  await nextTick();
  document.getElementById(`install-tab-${nextPlatform}`)?.focus();
}

onBeforeUnmount(() => clearTimeout(resetCopyStatus));
</script>

<template>
  <section id="install-the-beta" class="home-install" aria-labelledby="install-title">
    <div class="home-install__intro">
      <p class="home-eyebrow">{{ copy.beta }} {{ productVersion }}</p>
      <h2 id="install-title">{{ copy.title }}</h2>
      <p>{{ copy.description }}</p>
      <a :href="copy.guideLink">{{ copy.guide }}</a>
    </div>

    <div class="home-install__terminal">
      <div class="home-install__tabs" role="tablist" :aria-label="copy.platform">
        <button
          v-for="platform in platforms"
          :id="`install-tab-${platform}`"
          :key="platform"
          type="button"
          role="tab"
          :aria-controls="`install-panel-${platform}`"
          :aria-selected="activePlatform === platform"
          :tabindex="activePlatform === platform ? 0 : -1"
          @click="selectPlatform(platform)"
          @keydown="moveBetweenTabs($event, platform)"
        >
          {{ commands[platform].label }}
        </button>
      </div>

      <div
        v-for="platform in platforms"
        v-show="activePlatform === platform"
        :id="`install-panel-${platform}`"
        :key="platform"
        class="home-install__code"
        role="tabpanel"
        :aria-labelledby="`install-tab-${platform}`"
      >
        <div class="home-install__code-meta">
          <span>{{ commands[platform].language }}</span>
          <button type="button" @click="copyCommand(platform)">
            {{ copyStatus || copy.copyCommand }}
          </button>
        </div>
        <pre><code>{{ commands[platform].value }}</code></pre>
        <p class="visually-hidden" aria-live="polite">{{ copyStatus }}</p>
      </div>
    </div>
  </section>
</template>
