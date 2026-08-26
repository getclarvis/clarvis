import type { Accessor, Setter } from "solid-js";
import type { ProviderConfig } from "../../../adapters/settings.ts";
import type { CatalogProvider, ModelsCatalog } from "../../../adapters/models-catalog.ts";
import type { ViewHost } from "../../../keys/commands.ts";
import type {
  ProvidersController,
  ProviderMapField,
} from "../../../features/providers/controller.ts";
import type { HintTone } from "../../hint.ts";
import type { CatalogPickerSpec } from "../CatalogPicker.tsx";
import type { CatalogRow } from "../catalog-pick.ts";
import type { SubscriptionAccountStatus, SubscriptionScheme } from "@clarvis/protocol";
import type { FieldEditor } from "../field-editor.tsx";
import type { createMapEditor } from "../../../ui/patterns/map-editor.tsx";

/**
 * Shared state and transitions used by the three private provider screens.
 *
 * @remarks Three modules rather than one file because the Providers panel is
 * three *levels* — list, detail, model — that are all mounted at once and
 * navigated between, not three sections of one screen. That is why this context
 * exists at all: the levels have to share the controller, the editor and the
 * catalog while keeping their own selection state, and {@link detailRow} and
 * {@link modelRow} being separate signals is the concrete consequence. Splitting
 * by level keeps each file's imports to the level it draws, and keeps a change
 * to one level from re-rendering the reasoning about the others; the shared
 * surface is exactly this interface, so what crosses between them is
 * enumerable.
 */
export interface ProvidersViewContext {
  host: ViewHost;
  ctrl: ProvidersController;
  catalog: ModelsCatalog | null;
  notify: (message: string, tone?: HintTone) => void;
  editor: FieldEditor;
  maps: ReturnType<typeof createMapEditor>;
  /** Whether this panel was opened to configure Clarvis's first provider/model. */
  bootstrap: boolean;
  /** Whether the first provider came from the bootstrap's manual-entry row. */
  manualBootstrapProvider: Accessor<boolean>;
  setManualBootstrapProvider: Setter<boolean>;
  providers: Accessor<ProviderConfig[]>;
  current: Accessor<ProviderConfig | undefined>;
  sel: Accessor<number>;
  setSel: Setter<number>;
  drill: Accessor<number>;
  setDrill: Setter<number>;
  detailRow: Accessor<number>;
  setDetailRow: Setter<number>;
  /**
   * The selected field on the *model* level.
   *
   * @remarks Separate from {@link detailRow} because the two levels are both
   *   mounted: sharing one signal meant entering a model zeroed the provider
   *   detail's row, and escaping back landed on the first field rather than on
   *   the model the user came from — invariant 5 requires a mounted parent to
   *   keep its selection.
   */
  modelRow: Accessor<number>;
  setModelRow: Setter<number>;
  modelId: Accessor<string>;
  setModelId: Setter<string>;
  setPicker: Setter<CatalogPickerSpec | null>;
  subscriptionRows?: () => CatalogRow[];
  openSubscription?: (scheme: SubscriptionScheme) => void;
  subscriptionStatus?: (scheme: SubscriptionScheme) => SubscriptionAccountStatus | undefined;
  manageSubscription?: (scheme: SubscriptionScheme) => void;
  startEdit: (...args: Parameters<FieldEditor["start"]>) => void;
  enterKey: (envVar: string, onCommit?: () => void) => void;
  manualModelEntry: (onAdded?: (id: string) => void) => void;
  /** Completes first-run setup after its first manually-created model is added. */
  finishBootstrap: (provider: ProviderConfig, id: string) => void;
  openModelPicker: (provider: CatalogProvider, config?: ProviderConfig) => void;
  modelRemovalBlocked: (id: string) => boolean;
  openMap: (field: ProviderMapField, target: "provider" | "model") => void;
  mapCell: (map: Record<string, unknown> | undefined) => string;
}
