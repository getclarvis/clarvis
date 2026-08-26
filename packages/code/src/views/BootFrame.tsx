import type { JSX } from "solid-js";
import { tokens } from "../theme/tokens.ts";

/** Minimal parser-free frame shown while the interactive foundation is loading. */
export function BootFrame(): JSX.Element {
  return (
    <box
      position="absolute"
      left={0}
      right={0}
      top={0}
      bottom={0}
      backgroundColor={tokens.bg}
      justifyContent="center"
      alignItems="center"
    >
      <text fg={tokens.accent}>Clarvis · starting</text>
    </box>
  );
}
