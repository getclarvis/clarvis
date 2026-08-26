import { expect, test } from "bun:test";
import { join } from "node:path";

const SWEPT_SOURCES = [
  "src/adapters/code-config.ts",
  "src/adapters/guard-mode.ts",
  "src/adapters/session-store.ts",
  "src/adapters/settings.ts",
  "src/views/config/AgentsPanel.tsx",
  "src/views/config/DoctorView.tsx",
  "src/views/config/MarketplaceBrowser.tsx",
  "src/views/config/McpBrowser.tsx",
  "src/views/config/PluginBrowser.tsx",
  "src/views/config/RunControlsPanel.tsx",
  "src/views/config/SandboxConfigPanel.tsx",
  "src/views/config/ThemeView.tsx",
  "src/views/config/WorkflowsHub.tsx",
  "src/views/config/view-host.tsx",
];

function nonAscii(source: string): string[] {
  return [...source].filter((character) => character.codePointAt(0)! > 0x7f);
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("swept sources keep every rendered non-ascii character behind glyph()", async () => {
  for (const relativePath of SWEPT_SOURCES) {
    const source = await Bun.file(join(import.meta.dir, "..", "..", relativePath)).text();
    const offenders = [...new Set(nonAscii(stripComments(source)))];
    expect({ file: relativePath, offenders }).toEqual({ file: relativePath, offenders: [] });
  }
});
