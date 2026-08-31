import type { Accessor, JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { CliRenderer, PasteEvent, TextareaRenderable } from "@opentui/core";
import {
  createTextareaBindings,
  registerManagedTextareaLayer,
} from "@opentui/keymap/addons/opentui";
import type { Binding } from "@opentui/keymap";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { MessageContent } from "@clarvis/protocol";
import { tokens } from "../theme/tokens.ts";
import { borderChars, glyph } from "../theme/glyphs.ts";
import type { Platform } from "../adapters/platform.ts";
import type { Interaction } from "../keys/interaction.ts";
import { uiCommand } from "../keys/actions.ts";
import { LAYER, PROMPT_EDITING_KEYS } from "../ui/patterns/level-keys.ts";
import type { PromptHistory } from "../core/prompt-history.ts";
import {
  acceptMention,
  clampIndex,
  detectTrigger,
  parseBangCommand,
  parseSlashCommand,
  slashCompletion,
  type CompleteItem,
  type CompleteProvider,
} from "./input/autocomplete.ts";
import { AutocompletePopup } from "./input/AutocompletePopup.tsx";
import {
  attachmentAdmissionMessage,
  base64DecodedBytes,
  composeWithAttachments,
  createAttachmentStore,
  formatAttachmentBytes,
  nextAttachmentId,
  type Attachment,
  type AttachmentAdmission,
} from "./input/attachments.ts";
import { SurfaceBoundary } from "../ui/patterns/surface-lifecycle.tsx";

/**
 * How a submitted slash command was resolved: `"handled"` closes the draft,
 * `"block"` keeps it (an error was already surfaced) and `"pass"` lets the
 * dock submit the text as an ordinary message.
 */
export type SlashOutcome = "handled" | "block" | "pass";

/**
 * The prompt input: a textarea with history recall, `!`/`/` command routing,
 * image/file attachments and trigger-based autocomplete.
 */
export function InputDock(props: {
  interaction: Interaction;
  renderer: CliRenderer;
  platform: Platform;
  history: PromptHistory;
  providers?: CompleteProvider[];
  visible?: () => boolean;
  runActive?: () => boolean;
  onSubmit: (content: MessageContent) => void;
  onSlashCommand?: (name: string, args: string) => SlashOutcome;
  onBashCommand?: (cmd: string) => boolean;
  /** Non-null keeps the draft intact and refuses ordinary submissions. */
  submissionBlocked?: Accessor<string | null>;
  onReady?: (el: TextareaRenderable) => void;
  onDock?: (dock: {
    clearAttachments: () => void;
    restoreAttachments: (content: MessageContent) => void;
    popupOpen: () => boolean;
    expanded: () => boolean;
    closeEditor: () => void;
  }) => void;
  onNotify?: (message: string) => void;
  onDraftChange?: (nonEmpty: boolean) => void;
  onExpandedChange?: (expanded: boolean) => void;
  /** Reports whether slash/mention autocomplete currently owns the rows above the composer. */
  onPopupOpenChange?: (open: boolean) => void;
  targetLabel?: () => string;
}): JSX.Element {
  let ref: TextareaRenderable | undefined;
  const dims = useTerminalDimensions();
  const providers = (): CompleteProvider[] => props.providers ?? [];
  const [contentRows, setContentRows] = createSignal(1);
  const [visualRows, setVisualRows] = createSignal(1);
  const [expanded, setExpanded] = createSignal(false);
  const setEditorExpanded = (value: boolean): void => {
    setExpanded(value);
    props.onExpandedChange?.(value);
  };

  const [acOpen, setAcOpen] = createSignal(false);
  const [acItems, setAcItems] = createSignal<CompleteItem[]>([]);
  const [acIndex, setAcIndex] = createSignal(0);
  const [acLabel, setAcLabel] = createSignal("");
  const [acTermView, setAcTermView] = createSignal("");
  const [acHint, setAcHint] = createSignal(false);
  let acProvider: CompleteProvider | undefined;
  let acTerm: string | undefined;
  let acSuppressed = false;

  createEffect(() => props.onPopupOpenChange?.(acOpen()));

  const attachments = createAttachmentStore();

  function composeMessage(): MessageContent {
    return composeWithAttachments(ref?.plainText ?? "", attachments.list());
  }

  const maxInlineRows = createMemo(() =>
    Math.max(1, Math.min(12, Math.floor(Math.max(1, dims().height - 5) * 0.3))),
  );
  const inlineRows = createMemo(() => Math.min(visualRows(), maxInlineRows()));
  const targetLabel = (): string =>
    props.targetLabel?.() ?? (props.runActive?.() ? "Steer this run" : "New task");

  function syncDraftState(): void {
    const text = ref?.plainText ?? "";
    setContentRows(Math.max(1, text.split("\n").length));
    setVisualRows(Math.max(1, ref?.virtualLineCount ?? 1, ref?.lineInfo.lineStartCols.length ?? 1));
    props.onDraftChange?.(text.length > 0 || attachments.list().length > 0);
  }

  createEffect(() => {
    dims();
    if (!ref) return;
    const syncAfterLayout = (): void => syncDraftState();
    props.renderer.once("frame", syncAfterLayout);
    onCleanup(() => props.renderer.off("frame", syncAfterLayout));
  });

  function submit(): void {
    const text = ref?.plainText ?? "";
    const hasAttachments = attachments.list().length > 0;
    if (text.trim().length === 0 && !hasAttachments) return;
    const parsedSlash = props.onSlashCommand ? parseSlashCommand(text) : null;
    if (parsedSlash && props.onSlashCommand) {
      const outcome = props.onSlashCommand(parsedSlash.name, parsedSlash.args);
      if (outcome === "handled") {
        props.history.push(text.trim());
        ref?.setText("");
        return;
      }
      if (outcome === "block") return;
    }
    const blocked = props.submissionBlocked?.();
    if (blocked) {
      props.onNotify?.(blocked);
      return;
    }
    if (props.onBashCommand) {
      const bang = parseBangCommand(text);
      if (bang !== null) {
        if (bang.length === 0) {
          props.onNotify?.("type a command after !");
          return;
        }
        if (props.onBashCommand(bang)) {
          props.history.push(text.trim());
          ref?.setText("");
        }
        return;
      }
    }
    if (text.trim().length > 0) props.history.push(text);
    const content = composeMessage();
    ref?.setText("");
    attachments.clear();
    syncDraftState();
    props.onSubmit(content);
  }

  function notifyAttachmentRejection(admission: AttachmentAdmission): boolean {
    if (admission.ok) return false;
    props.onNotify?.(attachmentAdmissionMessage(admission));
    return true;
  }

  function addImageAttachment(data: string, mediaType: string, size: number): boolean {
    const att: Attachment = {
      id: nextAttachmentId(),
      kind: "image",
      label: "image",
      size,
      data,
      mediaType,
    };
    const admission = attachments.add(att);
    if (notifyAttachmentRejection(admission)) return false;
    syncDraftState();
    return true;
  }

  function restoreAttachments(content: MessageContent): void {
    if (!Array.isArray(content)) return;
    attachments.clear();
    for (const part of content) {
      if (part.type !== "image" || part.data === undefined) continue;
      addImageAttachment(part.data, part.mime, base64DecodedBytes(part.data));
    }
    syncDraftState();
  }

  let readingClipboardImage = false;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  async function onPasteImage(): Promise<void> {
    if (readingClipboardImage) return;
    // Count/aggregate exhaustion can be reported without spawning a clipboard
    // helper or asking it to materialize an image payload.
    if (notifyAttachmentRejection(attachments.canAddImage(1))) return;
    readingClipboardImage = true;
    try {
      const img = await props.platform.readClipboardImage();
      if (disposed) return;
      if (img) {
        const attached = addImageAttachment(img.data, img.mediaType, base64DecodedBytes(img.data));
        if (attached) props.onNotify?.("image attached from clipboard");
      } else {
        props.onNotify?.("no image in clipboard");
      }
    } catch {
      if (!disposed) props.onNotify?.("clipboard image read failed");
    } finally {
      readingClipboardImage = false;
    }
  }

  function atTop(): boolean {
    return (ref?.logicalCursor.row ?? 0) === 0;
  }
  function atBottom(): boolean {
    const text = ref?.plainText ?? "";
    return (ref?.logicalCursor.row ?? 0) === text.split("\n").length - 1;
  }
  function recall(text: string | undefined): void {
    if (text === undefined || !ref) return;
    ref.setText(text);
    ref.gotoBufferEnd();
  }
  function onUp(): void {
    if (atTop()) recall(props.history.prev(ref?.plainText ?? ""));
    else ref?.moveCursorUp();
  }
  function onDown(): void {
    if (atBottom()) recall(props.history.next());
    else ref?.moveCursorDown();
  }

  function closeAc(): void {
    if (props.interaction.keymap.getData("autocomplete") !== false)
      props.interaction.keymap.setData("autocomplete", false);
    acProvider = undefined;
    acTerm = undefined;
    setAcOpen(false);
    setAcIndex(0);
    setAcLabel("");
    setAcTermView("");
    setAcHint(false);
  }
  /**
   * Re-derive the autocomplete popup from the input's current text.
   *
   * @remarks Runs on every keystroke (wired to `onContentChange`), so
   *   `providers()` is read **once** into a local: it is a prop accessor, and a
   *   caller passing an inline array expression makes each read rebuild the
   *   whole provider list.
   */
  function refreshAc(): void {
    const list = providers();
    const text = ref?.plainText ?? "";
    const hit = detectTrigger(
      text,
      list.map((p) => p.trigger),
    );
    const provider = hit ? list.find((p) => p.trigger === hit.trigger) : undefined;
    if (!hit || !provider) {
      acSuppressed = false;
      closeAc();
      return;
    }
    if (acSuppressed) {
      closeAc();
      return;
    }
    const hint = provider.kind === "hint";
    const items = provider.query(hit.term);
    acProvider = provider;
    setAcIndex((i) => (hit.term === acTerm ? clampIndex(i, items.length) : 0));
    acTerm = hit.term;
    setAcItems(items);
    setAcLabel(provider.label);
    setAcTermView(hint ? "" : hit.term);
    setAcHint(hint);
    setAcOpen(true);
    if (props.interaction.keymap.getData("autocomplete") !== !hint)
      props.interaction.keymap.setData("autocomplete", !hint);
  }
  function acceptAc(): void {
    const currentText = ref?.plainText ?? "";
    const list = providers();
    const hit = detectTrigger(
      currentText,
      list.map((candidate) => candidate.trigger),
    );
    const provider = hit ? list.find((candidate) => candidate.trigger === hit.trigger) : undefined;
    const term = hit?.term;
    const cacheIsCurrent = provider === acProvider && term === acTerm;
    const items =
      provider && term !== undefined ? (cacheIsCurrent ? acItems() : provider.query(term)) : [];
    const item = items[clampIndex(cacheIsCurrent ? acIndex() : 0, items.length)];
    closeAc();
    if (!provider || provider.kind === "hint") {
      // The textarea can apply its last printable key after the popup's Solid
      // signals were derived. If Return arrives in that same stdin drain, the
      // stale autocomplete layer still owns it; submit the live text instead
      // of swallowing the key or accepting the previous provider.
      submit();
      return;
    }
    if (!item) {
      props.onNotify?.("no match");
      return;
    }
    if (provider.trigger.startsWith("/")) {
      const accepted = currentText.trim() === item.label ? { ...item, insert: "" } : item;
      ref?.setText(accepted.insert ?? "");
      ref?.gotoBufferEnd();
      provider.onAccept?.(accepted);
      return;
    }
    ref?.setText(acceptMention(ref?.plainText ?? "", provider.trigger, item.insert ?? item.value));
    ref?.gotoBufferEnd();
    provider.onAccept?.(item);
  }
  function completeAc(): void {
    const item = acItems()[clampIndex(acIndex(), acItems().length)];
    const provider = acProvider;
    if (item && provider && provider.trigger === "/") {
      ref?.setText(item.insert || slashCompletion(item.label));
      ref?.gotoBufferEnd();
      refreshAc();
      syncDraftState();
      return;
    }
    acceptAc();
  }

  createEffect(() => {
    if (!(props.visible?.() ?? true)) closeAc();
  });

  onMount(() => {
    ref?.focus();
    if (ref)
      ref.onContentChange = () => {
        refreshAc();
        syncDraftState();
      };
    props.onDock?.({
      clearAttachments: () => {
        attachments.clear();
        syncDraftState();
      },
      restoreAttachments,
      popupOpen: acOpen,
      expanded,
      closeEditor: () => setEditorExpanded(false),
    });

    const onPaste = (event: PasteEvent): void => {
      const kind = event.metadata?.kind;
      const mime = event.metadata?.mimeType;
      if (kind === "binary" || (mime && mime.startsWith("image/"))) {
        event.preventDefault();
        const bytes = event.bytes;
        // Refuse before Buffer/base64 creates another resident copy.
        if (notifyAttachmentRejection(attachments.canAddImage(bytes.length))) return;
        addImageAttachment(
          Buffer.from(bytes).toString("base64"),
          mime ?? "image/png",
          bytes.length,
        );
      }
    };
    props.renderer.keyInput.on("paste", onPaste);
    onCleanup(() => props.renderer.keyInput.off("paste", onPaste));

    const promptHandlers: Record<string, () => void> = {
      "prompt.send": () => submit(),
      "prompt.newline": () => void ref?.newLine(),
      "prompt.historyPrev": () => onUp(),
      "prompt.historyNext": () => onDown(),
      "prompt.attachImage": () => void onPasteImage(),
    };
    const promptRows = PROMPT_EDITING_KEYS.filter(
      (r): r is typeof r & { command: string } => !!r.command && r.command in promptHandlers,
    );
    const promptCommands = promptRows.map((r) =>
      uiCommand({
        id: r.command,
        title: r.desc,
        description: r.desc,
        category: "editing",
        surfaces: [...(r.command === "prompt.send" ? (["footer"] as const) : []), "full-help"],
        ...(r.command === "prompt.send"
          ? {
              footerLabel: "send / steer",
              hintPriority: 100,
              hintGroup: "primary" as const,
              essential: true,
            }
          : {}),
        run: () => promptHandlers[r.command]!(),
      }),
    );
    const overrides: Binding[] = promptRows.flatMap((r) =>
      r.keys.map((key): Binding => ({ key, cmd: r.command })),
    );
    const visible = (): boolean => props.visible?.() ?? true;
    const visibleMatcher = reactiveMatcherFromSignal(visible);
    const offCommands = props.interaction.keymap.registerLayer({
      enabled: visibleMatcher,
      commands: promptCommands,
    });
    const offInput = registerManagedTextareaLayer(props.interaction.keymap, props.renderer, {
      enabled: visibleMatcher,
      priority: LAYER.INPUT,
      bindings: createTextareaBindings(overrides),
    });
    onCleanup(() => {
      offInput();
      offCommands();
    });

    const registerEditorToggle = (isExpanded: boolean): (() => void) => {
      const id = isExpanded ? "prompt.editor.close" : "prompt.editor.open";
      const enabled = reactiveMatcherFromSignal(() => visible() && expanded() === isExpanded);
      return props.interaction.keymap.registerLayer({
        enabled,
        priority: isExpanded ? LAYER.OVERLAY : LAYER.INPUT,
        commands: [
          uiCommand({
            id,
            title: isExpanded ? "Collapse task editor" : "Expand task editor",
            description: isExpanded
              ? "Return to the conversation without losing the draft"
              : "Open the draft in the full Task editor",
            category: "editing",
            surfaces: ["footer", "full-help"],
            footerLabel: isExpanded ? "collapse editor" : "expand editor",
            hintPriority: 45,
            hintGroup: "navigation",
            run: () => setEditorExpanded(!isExpanded),
          }),
        ],
        bindings: [{ key: "ctrl+g", cmd: id }, ...(isExpanded ? [{ key: "escape", cmd: id }] : [])],
      });
    };
    const offCollapsedEditor = registerEditorToggle(false);
    const offExpandedEditor = registerEditorToggle(true);
    onCleanup(() => {
      offExpandedEditor();
      offCollapsedEditor();
    });

    const dismissAutocomplete = (): void => {
      acSuppressed = true;
      closeAc();
    };
    const offAc = props.interaction.keymap.registerLayer({
      enabled: visibleMatcher,
      priority: LAYER.MODAL,
      when: "autocomplete",
      commands: [
        uiCommand({
          id: "autocomplete.previous",
          title: "Previous completion",
          description: "Select the previous completion",
          category: "navigation",
          surfaces: ["footer"],
          footerLabel: "choose",
          hintPriority: 60,
          hintGroup: "navigation",
          run: () => {
            setAcIndex((i) => clampIndex(i - 1, acItems().length));
          },
        }),
        uiCommand({
          id: "autocomplete.next",
          title: "Next completion",
          description: "Select the next completion",
          category: "navigation",
          surfaces: ["full-help"],
          run: () => {
            setAcIndex((i) => clampIndex(i + 1, acItems().length));
          },
        }),
        uiCommand({
          id: "autocomplete.complete",
          title: "Complete selection",
          description: "Insert the selected command or value",
          category: "primary",
          surfaces: ["footer"],
          footerLabel: "complete",
          hintPriority: 80,
          hintGroup: "primary",
          run: completeAc,
        }),
        uiCommand({
          id: "autocomplete.accept",
          title: "Run selection",
          description: "Run or accept the selected completion",
          category: "primary",
          surfaces: ["footer"],
          footerLabel: "run",
          hintPriority: 90,
          hintGroup: "primary",
          run: acceptAc,
        }),
        uiCommand({
          id: "autocomplete.close",
          title: "Close completion",
          description: "Close autocomplete without changing the draft",
          category: "escape",
          surfaces: ["footer"],
          footerLabel: "close",
          hintPriority: 40,
          hintGroup: "escape",
          run: dismissAutocomplete,
        }),
      ],
      bindings: [
        { key: "up", cmd: "autocomplete.previous" },
        { key: "ctrl+p", cmd: "autocomplete.previous" },
        { key: "down", cmd: "autocomplete.next" },
        { key: "ctrl+n", cmd: "autocomplete.next" },
        { key: "tab", cmd: "autocomplete.complete" },
        { key: "return", cmd: "autocomplete.accept" },
        { key: "escape", cmd: "autocomplete.close" },
      ],
    });
    onCleanup(offAc);
  });

  return (
    <box
      id="input-dock"
      flexDirection="column"
      flexShrink={expanded() ? 1 : 0}
      flexGrow={expanded() ? 1 : 0}
      minHeight={expanded() ? 0 : undefined}
      visible={props.visible?.() ?? true}
      backgroundColor={tokens.bg}
      paddingLeft={expanded() ? 1 : 0}
      paddingRight={expanded() ? 1 : 0}
    >
      <Show when={expanded()}>
        <box flexDirection="row" height={2} flexShrink={0} alignItems="center">
          <text fg={tokens.accent} selectable={false}>
            <b>Task editor</b>
          </text>
          <text
            fg={tokens.muted}
            selectable={false}
          >{`  ${targetLabel()} · ${contentRows()} lines · unsent draft`}</text>
        </box>
      </Show>
      <SurfaceBoundary active={acOpen} retention="retain-one">
        {(lifecycle) => (
          <AutocompletePopup
            visible={lifecycle.active()}
            label={acLabel()}
            items={acItems()}
            index={acHint() ? -1 : acIndex()}
            term={acTermView()}
            onSelect={acHint() ? undefined : setAcIndex}
            onConfirm={acHint() ? undefined : acceptAc}
          />
        )}
      </SurfaceBoundary>
      <Show when={attachments.list().length > 0}>
        <box flexDirection="row" paddingLeft={1} flexShrink={0}>
          <For each={attachments.list()}>
            {(att) => (
              <box flexDirection="row" paddingLeft={1} paddingRight={1}>
                <text fg={tokens.muted}>{glyph("image") + " "}</text>
                <text fg={tokens.muted}>{att.label}</text>
                <Show when={att.size}>
                  <text fg={tokens.muted}>{" " + formatAttachmentBytes(att.size!)}</text>
                </Show>
                <text
                  fg={tokens.warn}
                  onMouseDown={() => {
                    attachments.remove(att.id);
                    syncDraftState();
                  }}
                >
                  {" " + glyph("close")}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <box
        border
        borderStyle="rounded"
        customBorderChars={borderChars()}
        borderColor={props.runActive?.() ? tokens.accent2 : tokens.muted}
        paddingLeft={1}
        flexShrink={expanded() ? 1 : 0}
        flexGrow={expanded() ? 1 : 0}
        minHeight={expanded() ? 0 : undefined}
      >
        <textarea
          ref={(el: TextareaRenderable) => {
            ref = el;
            props.onReady?.(el);
          }}
          height={expanded() ? "100%" : inlineRows()}
          wrapMode="char"
          placeholder={`${targetLabel()}${glyph("ellipsis")}  (/ commands)`}
          placeholderColor={tokens.muted}
          textColor={tokens.fg}
          focusedTextColor={tokens.fg}
        />
      </box>
    </box>
  );
}
