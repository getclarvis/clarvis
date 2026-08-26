import type { JSX } from "solid-js";
import type { ViewHost } from "../../keys/commands.ts";
import { HubMenu } from "./hub-menu.tsx";
import { EXTENSIONS_ITEMS } from "./hub-items.ts";

/** Renders the Extensions {@link HubMenu} over {@link EXTENSIONS_ITEMS}. */
export function ExtensionsHub(
  host: ViewHost,
  deps: { openChild: (cmd: string) => void },
): JSX.Element {
  return HubMenu(host, { title: "Extensions", items: EXTENSIONS_ITEMS, openChild: deps.openChild });
}
