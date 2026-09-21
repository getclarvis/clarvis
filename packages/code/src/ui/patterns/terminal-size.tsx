import { createContext, useContext, type Accessor, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";

/** Terminal geometry in cells, as a mounted tree shares it. */
export interface TerminalSize {
  width: number;
  height: number;
}

const TerminalSizeContext = createContext<Accessor<TerminalSize>>();

/**
 * Publishes one terminal-size subscription to a whole mounted tree.
 *
 * @param props.size - the shell's own terminal-size accessor.
 * @remarks `useTerminalDimensions` subscribes on every call, and OpenTUI's renderer
 *   caps resize listeners. Every nested surface that needs geometry therefore
 *   shares the shell's single subscription instead of adding its own — a dozen
 *   mounted frames each subscribing both overspends the renderer's listener
 *   budget and rebuilds the same value a dozen times per resize.
 */
export function TerminalSizeProvider(props: {
  size: Accessor<TerminalSize>;
  children: JSX.Element;
}): JSX.Element {
  return (
    <TerminalSizeContext.Provider value={props.size}>{props.children}</TerminalSizeContext.Provider>
  );
}

/**
 * The tree's shared terminal size.
 *
 * @returns an accessor for the terminal geometry in cells.
 * @remarks A surface mounted outside {@link TerminalSizeProvider} — a focused
 *   renderer test, a standalone frame — falls back to its own subscription, so
 *   the shared path is an optimization the shell owns rather than a requirement
 *   every caller has to satisfy.
 */
export function useTerminalSize(): Accessor<TerminalSize> {
  const shared = useContext(TerminalSizeContext);
  return shared ?? useTerminalDimensions();
}
