import type { JSX } from "solid-js";
import { createSignal } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { bindLevelKeys, SelectableList, SelectableRow, ViewFrame } from "./view-host.tsx";

/** One selectable row in a {@link HubMenu}. */
export interface HubMenuItem {
  id: string;
  label: string;
  desc: string;
  /** Command name to open when this item is activated. */
  cmd: string;
}

/**
 * A flat, read-only "menu of children" screen shared by every hub (Settings,
 * Extensions, ...): selecting a row opens its command as an independent
 * top-level view via `openChild` — see `openWithReturn` in app-commands.tsx
 * for how the child finds its way back here.
 */
export function HubMenu(
  host: ViewHost,
  deps: { title: string; items: readonly HubMenuItem[]; openChild: (cmd: string) => void },
): JSX.Element {
  const [sel, setSel] = createSignal(0);
  const items = (): readonly HubMenuItem[] => deps.items;
  const selected = (): HubMenuItem | undefined => items()[clampListIndex(sel(), items().length)];

  const spec = (): LevelSpec => ({
    nav: {
      count: () => items().length,
      index: sel,
      setIndex: setSel,
      activate: {
        label: "open",
        run: () => {
          const item = selected();
          if (item) deps.openChild(item.cmd);
        },
      },
    },
  });

  bindLevelKeys({
    host,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  return (
    <ViewFrame host={host} title={deps.title}>
      <SelectableList<HubMenuItem>
        each={items}
        sel={sel}
        idPrefix="hub-"
        row={(item, i) => (
          <SelectableRow selected={sel() === i()}>
            <span style={{ fg: tokens.fg }}>{item.label}</span>
            <span style={{ fg: tokens.muted }}>{"  " + item.desc}</span>
          </SelectableRow>
        )}
      />
    </ViewFrame>
  );
}
