import type { JSX } from "solid-js";
import type { ViewHost } from "../../keys/commands.ts";
import { HubMenu } from "./hub-menu.tsx";
import { SETTINGS_ITEMS } from "./hub-items.ts";

export { SETTINGS_ITEMS as ITEMS } from "./hub-items.ts";

/** Renders the Settings {@link HubMenu} over {@link SETTINGS_ITEMS}. */
export function SettingsHub(
  host: ViewHost,
  deps: { openChild: (cmd: string) => void },
): JSX.Element {
  return HubMenu(host, { title: "Settings", items: SETTINGS_ITEMS, openChild: deps.openChild });
}
