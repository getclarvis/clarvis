import { KEYMAP_EXTENSION_CONTEXT, type Keymap } from "@opentui/keymap";
import { getGraphSnapshot, type GraphSnapshot } from "@opentui/keymap/extras/graph";
import type { KeyEvent, Renderable } from "@opentui/core";

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>;

/**
 * One announced key sequence as a stable map key.
 *
 * @param sequence - the raw `display` parts of a binding sequence.
 * @returns the parts joined by a single space.
 * @remarks Both halves of the comparison — the projection's announced keys and
 *   the graph snapshot's bindings — read `display` off the same compiled
 *   sequence parts, so joining here cannot disagree with what the keymap
 *   dispatched.
 */
export function sequenceKey(sequence: readonly string[]): string {
  return sequence.join(" ");
}

/**
 * The command the keymap would actually dispatch for each live key sequence.
 *
 * @param keymap - the application keymap.
 * @returns sequence key → winning command name. Empty when the keymap exposes no
 *   layer graph (a focused-render double), which keeps every announced key.
 * @remarks A command can be *reachable* and still never receive its key: a
 *   higher-precedence layer binding the same sequence wins. `getCommandEntries`
 *   reports each command independently and cannot answer that, so the footer
 *   projected `[Ctrl+X P] open plan` beside the Plan page's own
 *   `[Ctrl+X P] close` even though only the latter could fire.
 *
 *   The winner is resolved from the keymap's own layer graph: the first
 *   *viable* binding for a sequence in layer precedence order — priority
 *   descending, then later registration first, which is the order
 *   `state.sortedLayers` itself uses. Reading the graph's `shadowed` flag
 *   instead looks equivalent and is not: a sequence written with a token
 *   (`<leader>p`) compiles per layer, so the flag misses a cross-layer claim on
 *   a token binding — exactly the shape this projection has to resolve. A
 *   binding whose command is disabled, inactive or unresolved cannot win, and is
 *   skipped so the lower one that would really fire keeps its key.
 */
export function liveSequenceOwners(keymap: OpenTuiKeymap): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  if (typeof keymap[KEYMAP_EXTENSION_CONTEXT] !== "function") return owners;
  let snapshot: GraphSnapshot<Renderable, KeyEvent>;
  try {
    snapshot = getGraphSnapshot(keymap);
  } catch (error) {
    // A queued keymap state change can land after the host was destroyed, which
    // is exactly when `useKeymapSelector` returns its previous value instead of
    // throwing. A destroyed keymap owns no sequence, so the band keeps what it
    // announced; any other failure still surfaces.
    if (
      error instanceof Error &&
      error.message === "Cannot use a keymap after its host was destroyed"
    )
      return owners;
    throw error;
  }
  const layers = new Map(snapshot.layers.map((layer) => [layer.id, layer]));
  const ordered = [...snapshot.bindings].sort((left, right) => {
    const a = layers.get(left.layerId);
    const b = layers.get(right.layerId);
    return (b?.priority ?? 0) - (a?.priority ?? 0) || (b?.order ?? 0) - (a?.order ?? 0);
  });
  for (const binding of ordered) {
    if (!binding.active || typeof binding.command !== "string") continue;
    if (binding.inactiveReasons.some((reason) => reason.startsWith("command-"))) continue;
    const key = sequenceKey(binding.sequence.map((part) => part.display));
    if (!owners.has(key)) owners.set(key, binding.command);
  }
  return owners;
}
