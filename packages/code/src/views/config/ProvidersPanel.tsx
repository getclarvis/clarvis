import type { JSX } from "solid-js";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { ProviderConfig, SettingsAdapter } from "../../adapters/settings.ts";
import type { KeysAdapter } from "../../adapters/provider-secrets.ts";
import type { CodeConfigStore } from "../../adapters/code-config.ts";
import {
  catalogProviderFromProtocol,
  type CatalogProvider,
  type ModelsCatalog,
} from "../../adapters/models-catalog.ts";
import type {
  DeviceAuthorization,
  ModelCatalogService,
  ProviderAuthService,
  SubscriptionAccountStatus,
  SubscriptionScheme,
} from "@clarvis/protocol";
import type { ViewHost } from "../../keys/commands.ts";
import type { HintTone } from "../hint.ts";
import { glyph } from "../../theme/glyphs.ts";
import { createMapEditor } from "../../ui/patterns/map-editor.tsx";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import {
  createProvidersController,
  type ModelRemovalBlock,
  type ProviderMapField,
} from "../../features/providers/controller.ts";
import {
  bodyFootnote,
  bodyKeyProblem,
  bodySuggestions,
  headerKeyProblem,
  headersFootnote,
  headerSuggestions,
  headerValueProblem,
} from "../../features/providers/request-params.ts";
import { presentProvidersEvent } from "../../features/providers/events.ts";
import { detachObserved } from "../../core/tasks.ts";
import { errorText } from "../../adapters/errors.ts";
import { modelRows } from "./catalog-pick.ts";
import type { CatalogPickerSpec } from "./CatalogPicker.tsx";
import { promptForApiKey } from "./key-entry.ts";
import { bindLevelKeys, createFieldEditor, LevelHost } from "./view-host.tsx";
import type { ProvidersViewContext } from "./providers/context.ts";
import { spinnerChar, useSpinnerClock } from "../spinner.ts";
import { createProviderListLevel } from "./providers/list-level.tsx";
import {
  createProviderDetailLevel,
  PROVIDER_DETAIL_FIELDS,
  PROVIDER_ISSUE_DETAIL_FIELD,
} from "./providers/detail-level.tsx";
import { createProviderModelLevel } from "./providers/model-level.tsx";

/** Data and actions {@link ProvidersPanel} needs from its host. */
export interface ProvidersDeps {
  settings: SettingsAdapter;
  keys: KeysAdapter;
  code: CodeConfigStore;
  notify: (message: string, tone?: HintTone) => void;
  /** The loaded model catalog (from the kernel), for provider/model seeding. */
  catalog: ModelsCatalog | null;
  modelsService?: ModelCatalogService;
  providerAuth?: ProviderAuthService;
  copyText?: (text: string) => Promise<boolean>;
  openUrl?: (url: string) => Promise<boolean>;
  /** Starts the guided first-provider/first-model setup instead of the ordinary list. */
  bootstrap?: boolean;
  /** Hands a completed first provider back to the dedicated onboarding flow. */
  onBootstrapComplete?: (result: { model: string; reconnectRequired: boolean }) => void;
}

/** Facade that owns provider-panel lifecycle, shared state, and level composition. */
export function ProvidersPanel(host: ViewHost, deps: ProvidersDeps): JSX.Element {
  const bootstrap = deps.bootstrap === true;
  const editor = createFieldEditor(host.interaction, host.active);
  const ctrl = createProvidersController({
    settings: deps.settings,
    keys: deps.keys,
    code: deps.code,
    catalog: deps.catalog,
    scope: () => host.scope(),
    markDirty: (value?: boolean) => host.markDirty(value),
    emit: (event) => {
      const notice = presentProvidersEvent(event);
      deps.notify(notice.message, notice.tone);
    },
    onReconnect: deps.onBootstrapComplete ? undefined : () => host.dispatch("backend.reconnect"),
    manageDefaultModel: bootstrap,
  });
  onCleanup(() => ctrl.dispose());

  const [sel, setSel] = createSignal(0);
  const [drill, setDrill] = createSignal(0);
  const [detailRow, setDetailRow] = createSignal(0);
  const [modelRow, setModelRow] = createSignal(0);
  const [modelId, setModelId] = createSignal("");
  const [picker, setPicker] = createSignal<CatalogPickerSpec | null>(null);
  const [manualBootstrapProvider, setManualBootstrapProvider] = createSignal(false);
  const [subscriptionStatuses, setSubscriptionStatuses] = createSignal<SubscriptionAccountStatus[]>(
    [],
  );
  const [activeDevice, setActiveDevice] = createSignal<DeviceAuthorization | null>(null);
  const [countdownNow, setCountdownNow] = createSignal(Date.now());
  const [deviceActionFeedback, setDeviceActionFeedback] = createSignal<{
    action: "copy_code" | "open_url" | "copy_url";
    phase: "pending" | "succeeded";
  } | null>(null);
  let activeAttemptId: string | undefined;
  let deviceActionRequest = 0;
  let deviceActionFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  useSpinnerClock(() => deviceActionFeedback()?.phase === "pending");
  createEffect(() => {
    if (!host.active() || activeDevice() === null) return;
    setCountdownNow(Date.now());
    const timer = setInterval(() => setCountdownNow(Date.now()), 1_000);
    timer.unref?.();
    onCleanup(() => clearInterval(timer));
  });
  const providers = ctrl.providers;
  const current = (): ProviderConfig | undefined => providers()[drill()];
  const maps = createMapEditor({ editor, notify: deps.notify, level: host.level });
  const startEdit = (...args: Parameters<typeof editor.start>): void => editor.start(...args);

  host.bindScope({ mode: "reload", load: ctrl.load });
  host.onCancel(ctrl.clearPending);
  ctrl.load();

  const subscriptionLabel = (scheme: SubscriptionScheme): string =>
    scheme === "openai-codex" ? "ChatGPT subscription" : "Grok subscription";

  function refreshSubscriptionStatuses(): void {
    if (deps.providerAuth === undefined) return;
    detachObserved(
      "provider_subscription_status",
      async () => setSubscriptionStatuses(await deps.providerAuth!.list()),
      () => setSubscriptionStatuses([]),
    );
  }

  function subscriptionRows() {
    const statuses = new Map(subscriptionStatuses().map((status) => [status.scheme, status]));
    return (["openai-codex", "xai-grok"] as const).map((scheme) => {
      const status = statuses.get(scheme);
      const state = status?.state ?? (deps.providerAuth === undefined ? "unavailable" : "checking");
      return {
        id: scheme,
        label: subscriptionLabel(scheme),
        haystack: `${scheme} ${subscriptionLabel(scheme)} ${state}`,
        detail:
          host.scope() !== "global"
            ? "Switch to global scope to configure a personal subscription"
            : state === "unavailable"
              ? "Integration not enabled in this build"
              : state === "connected"
                ? `connected${status?.plan ? ` ${glyph("separator")} ${status.plan}` : ""}`
                : state === "expired" || state === "reauthentication_required"
                  ? "reauthentication required"
                  : state,
      };
    });
  }

  async function loadEntitled(scheme: SubscriptionScheme): Promise<void> {
    if (deps.modelsService === undefined) {
      deps.notify("Subscription model catalog is unavailable in this client", "error");
      return;
    }
    try {
      const entitled = catalogProviderFromProtocol(await deps.modelsService.getEntitled(scheme));
      let index = providers().findIndex((provider) => provider.kind === scheme);
      const config = index >= 0 ? providers()[index]! : ctrl.addSubscriptionProvider(entitled);
      if (index < 0) index = providers().length - 1;
      setDrill(index);
      setDetailRow(0);
      setManualBootstrapProvider(false);
      if (host.level.depth() === 0) host.level.push(config.name);
      openModelPicker(entitled, config);
    } catch (error) {
      deps.notify(
        `Connected, but the entitled model catalog failed ${glyph("emDash")} ${errorText(error)}`,
        "error",
      );
      let index = providers().findIndex((provider) => provider.kind === scheme);
      if (index < 0) {
        ctrl.addSubscriptionProvider({
          id: scheme,
          name: subscriptionLabel(scheme),
          kind: scheme,
          needsBaseUrl: false,
          models: [],
        });
        index = providers().length - 1;
      }
      setDrill(index);
      if (host.level.depth() === 0) host.level.push(providers()[index]!.name);
      setPicker({
        title: `Unverified entitlement ${glyph("emDash")} manual model`,
        rows: () => [],
        onManual: () => {
          setPicker(null);
          manualModelEntry(
            bootstrap
              ? (id) => {
                  const selected = current();
                  if (selected) finishBootstrap(selected, id);
                }
              : undefined,
          );
        },
        onClose: () => setPicker(null),
        onPick: () => undefined,
      });
    }
  }

  function clearDevice(): void {
    activeAttemptId = undefined;
    setActiveDevice(null);
    deviceActionRequest += 1;
    if (deviceActionFeedbackTimer !== undefined) clearTimeout(deviceActionFeedbackTimer);
    deviceActionFeedbackTimer = undefined;
    setDeviceActionFeedback(null);
  }

  function beginDeviceAction(action: "copy_code" | "open_url" | "copy_url"): number {
    const request = ++deviceActionRequest;
    if (deviceActionFeedbackTimer !== undefined) clearTimeout(deviceActionFeedbackTimer);
    deviceActionFeedbackTimer = undefined;
    setDeviceActionFeedback({ action, phase: "pending" });
    return request;
  }

  function finishDeviceAction(
    request: number,
    action: "copy_code" | "open_url" | "copy_url",
  ): void {
    if (request !== deviceActionRequest) return;
    setDeviceActionFeedback({ action, phase: "succeeded" });
    deviceActionFeedbackTimer = setTimeout(() => {
      if (request !== deviceActionRequest) return;
      setDeviceActionFeedback(null);
      deviceActionFeedbackTimer = undefined;
    }, 2_400);
    deviceActionFeedbackTimer.unref?.();
  }

  function failDeviceAction(request: number, error: unknown): void {
    if (request !== deviceActionRequest) return;
    setDeviceActionFeedback(null);
    deps.notify(errorText(error), "error");
  }

  function cancelDevice(): void {
    const id = activeAttemptId;
    clearDevice();
    setPicker(null);
    if (id !== undefined && deps.providerAuth !== undefined) {
      detachObserved("provider_subscription_cancel", () => deps.providerAuth!.cancel(id));
    }
  }

  function showDevice(scheme: SubscriptionScheme, device: DeviceAuthorization): void {
    activeAttemptId = device.attempt_id;
    setActiveDevice(device);
    setPicker({
      title: `${subscriptionLabel(scheme)} ${glyph("separator")} Device login`,
      stayOpen: true,
      compact: true,
      rows: () => {
        const currentDevice = activeDevice();
        if (currentDevice === null) return [];
        const seconds = Math.max(0, Math.ceil((currentDevice.expires_at - countdownNow()) / 1_000));
        const actionRow = (
          action: "copy_code" | "open_url" | "copy_url",
          idleLabel: string,
          idleDetail: string,
        ) => {
          const feedback = deviceActionFeedback();
          if (feedback?.action !== action)
            return {
              id: action,
              label: idleLabel,
              haystack:
                action === "copy_code"
                  ? "copy code"
                  : action === "copy_url"
                    ? "copy url"
                    : "open url",
              detail: idleDetail,
            };
          const copying = action === "copy_code" || action === "copy_url";
          return {
            id: action,
            label:
              feedback.phase === "pending"
                ? `${spinnerChar()} ${copying ? "Copying to clipboard" : "Opening browser"}${glyph("ellipsis")}`
                : `${glyph("success")} ${copying ? "Copied to clipboard" : "Browser opened"}`,
            haystack: copying ? "copy clipboard" : "open browser url",
            detail: action === "copy_code" ? "login code" : "verification URL",
          };
        };
        return [
          actionRow(
            "copy_code",
            `Code: ${currentDevice.user_code}`,
            `${seconds}s remaining ${glyph("separator")} copy code`,
          ),
          actionRow("open_url", "Open verification URL", "open browser"),
          actionRow("copy_url", `URL: ${currentDevice.verification_url}`, "copy URL"),
          { id: "cancel", label: "Cancel login", haystack: "cancel" },
        ];
      },
      onClose: cancelDevice,
      onPick: (action) => {
        const currentDevice = activeDevice();
        if (currentDevice === null) return;
        if (action === "cancel") {
          cancelDevice();
          return;
        }
        const value =
          action === "copy_code" ? currentDevice.user_code : currentDevice.verification_url;
        if (action === "open_url") {
          if (deps.openUrl === undefined) {
            deps.notify("Browser opening is unavailable; copy and open the URL manually", "warn");
            return;
          }
          const request = beginDeviceAction(action);
          detachObserved(
            "provider_subscription_open_url",
            async () => {
              if (!(await deps.openUrl!(value))) throw new Error("browser could not open the URL");
              if (request !== deviceActionRequest) return;
              finishDeviceAction(request, action);
              deps.notify("Browser opened", "success");
            },
            (error) => failDeviceAction(request, error),
          );
          return;
        }
        if (deps.copyText === undefined) {
          deps.notify("Clipboard unavailable", "warn");
          return;
        }
        if (action !== "copy_code" && action !== "copy_url") return;
        const request = beginDeviceAction(action);
        detachObserved(
          "provider_subscription_copy",
          async () => {
            if (!(await deps.copyText!(value))) throw new Error("clipboard unavailable");
            if (request !== deviceActionRequest) return;
            finishDeviceAction(request, action);
            deps.notify(
              action === "copy_code" ? "Login code copied" : "Verification URL copied",
              "success",
            );
          },
          (error) => failDeviceAction(request, error),
        );
      },
    });
    detachObserved(
      "provider_subscription_wait",
      async () => {
        const result = await deps.providerAuth!.wait(device.attempt_id);
        if (activeAttemptId !== device.attempt_id) return;
        clearDevice();
        setPicker(null);
        refreshSubscriptionStatuses();
        if (result.state === "connected") {
          deps.notify(`${subscriptionLabel(scheme)} connected`, "success");
          await loadEntitled(scheme);
        } else {
          deps.notify(
            result.state === "expired"
              ? "Device login expired; start a new login"
              : "Device login did not complete",
            "warn",
          );
        }
      },
      (error) => {
        if (activeAttemptId !== device.attempt_id) return;
        clearDevice();
        setPicker(null);
        deps.notify(`Subscription login failed ${glyph("emDash")} ${errorText(error)}`, "error");
      },
    );
  }

  function openSubscription(scheme: SubscriptionScheme): void {
    if (host.scope() !== "global") {
      deps.notify("Subscriptions can be configured only in global scope", "warn");
      return;
    }
    const status = subscriptionStatuses().find((item) => item.scheme === scheme);
    if (deps.providerAuth === undefined || status?.authorization_available === false) {
      deps.notify("Integration not enabled in this build", "warn");
      return;
    }
    if (status?.state === "connected") {
      detachObserved("provider_subscription_catalog", () => loadEntitled(scheme));
      return;
    }
    detachObserved(
      "provider_subscription_start",
      async () => showDevice(scheme, await deps.providerAuth!.startDevice(scheme)),
      (error) =>
        deps.notify(`Subscription login failed ${glyph("emDash")} ${errorText(error)}`, "error"),
    );
  }

  function subscriptionStatus(scheme: SubscriptionScheme): SubscriptionAccountStatus | undefined {
    return subscriptionStatuses().find((item) => item.scheme === scheme);
  }

  function manageSubscription(scheme: SubscriptionScheme): void {
    const status = subscriptionStatus(scheme);
    if (status?.state !== "connected") {
      openSubscription(scheme);
      return;
    }
    if (deps.providerAuth === undefined) return;
    detachObserved("provider_subscription_disconnect_confirm", () =>
      host
        .confirm({
          message: `disconnect ${subscriptionLabel(scheme)}?`,
          danger: true,
          detail: ["Local subscription credentials will be removed."],
          confirmLabel: "disconnect",
          cancelLabel: "keep connected",
        })
        .then(async (ok) => {
          if (!ok) return;
          await deps.providerAuth!.disconnect(scheme);
          refreshSubscriptionStatuses();
          deps.notify(`${subscriptionLabel(scheme)} disconnected`, "success");
        }),
    );
  }

  function enterKey(envVar: string, onCommit?: () => void): void {
    promptForApiKey(editor, envVar, {
      notify: deps.notify,
      usageNote: ctrl.keyUsageNote(envVar),
      commit: (value) => {
        ctrl.stageKey(envVar, value);
        onCommit?.();
      },
    });
  }

  function manualModelEntry(onAdded?: (id: string) => void): void {
    const firstManualModel =
      manualBootstrapProvider() && Object.keys(current()?.models ?? {}).length === 0;
    startEdit(
      firstManualModel
        ? `Set up Clarvis ${glyph("separator")} Step 2 of 2 ${glyph("separator")} Model ID`
        : "Model ID",
      "",
      (value) => {
        const id = value.trim();
        if (!id) return;
        ctrl.addBlankModel(drill(), id);
        if (onAdded) {
          onAdded(id);
          return;
        }
        setModelId(id);
        setModelRow(0);
        host.level.push(id);
      },
    );
  }

  function modelRemovalBlocked(id: string): boolean {
    const provider = current();
    if (!provider) return false;
    const block = ctrl.modelRemovalBlocked(provider, id);
    if (!block) return false;
    deps.notify(presentModelRemovalBlock(block), "error");
    return true;
  }

  function presentModelRemovalBlock(block: ModelRemovalBlock): string {
    if (block.kind === "default-model") {
      return `can't remove ${glyph("emDash")} ${block.model} is the default_model; change the default first`;
    }
    return `can't remove ${glyph("emDash")} ${block.model} is used by agent ${block.agents.join(", ")}; stop referencing it there first`;
  }

  function toggleModel(provider: CatalogProvider, id: string): void {
    if (current()?.models?.[id]) {
      if (modelRemovalBlocked(id)) return;
      ctrl.removeModel(drill(), id);
      deps.notify(`removed ${id}`);
      return;
    }
    ctrl.addModelFromCatalog(
      drill(),
      id,
      provider.models.find((model) => model.modelId === id),
    );
  }

  function saveBootstrap(provider: ProviderConfig, id: string): void {
    const modelRef = `${provider.name}/${id}`;
    const reconnectRequired = ctrl.pendingKeys().size > 0 || ctrl.pendingSources().size > 0;
    detachObserved(
      "provider_bootstrap_save",
      async () => {
        if ((await ctrl.save()) !== "ok") return;
        deps.notify(`Setup complete ${glyph("emDash")} ${modelRef} is ready`, "success");
        deps.onBootstrapComplete?.({ model: modelRef, reconnectRequired });
        host.close();
      },
      (error) => deps.notify(`Setup failed ${glyph("emDash")} ${errorText(error)}`, "error"),
    );
  }

  function finishBootstrap(provider: ProviderConfig, id: string): void {
    ctrl.setDefaultModel(`${provider.name}/${id}`);
    const envVar = provider.api_key_env;
    if (envVar && ctrl.envStatusOf(envVar) === "unset" && !ctrl.pendingKeys().has(envVar)) {
      enterKey(envVar, () => saveBootstrap(provider, id));
      return;
    }
    saveBootstrap(provider, id);
  }

  function openModelPicker(provider: CatalogProvider, config?: ProviderConfig): void {
    const choosingFirstModel =
      bootstrap && ctrl.defaultModel() === undefined && ctrl.effectiveDefaultModel() === undefined;
    setPicker({
      title: choosingFirstModel
        ? `Set up Clarvis ${glyph("separator")} Step 2 of 2 ${glyph("separator")} Model`
        : `Add models ${glyph("emDash")} ${provider.id}`,
      stayOpen: !choosingFirstModel,
      counterLabel: "models",
      counter: () => Object.keys(current()?.models ?? {}).length,
      rows: () => modelRows(provider.models, new Set(Object.keys(current()?.models ?? {}))),
      onManual: () => {
        setPicker(null);
        manualModelEntry(
          choosingFirstModel
            ? (id) => {
                const selected = current();
                if (selected) finishBootstrap(selected, id);
              }
            : undefined,
        );
      },
      onClose: () => {
        setPicker(null);
        if (choosingFirstModel) {
          deps.notify("Choose a model to finish setup", "warn");
          return;
        }
        if (!config) return;
        const count = Object.keys(current()?.models ?? {}).length;
        deps.notify(`'${config.name}' ready ${glyph("emDash")} ${count} models`);
        if (config.api_key_env && ctrl.envStatusOf(config.api_key_env) === "unset")
          enterKey(config.api_key_env);
      },
      onPick: (id) => {
        if (!choosingFirstModel) {
          toggleModel(provider, id);
          return;
        }
        const selected = current();
        if (!selected) return;
        ctrl.addModelFromCatalog(
          drill(),
          id,
          provider.models.find((model) => model.modelId === id),
        );
        setPicker(null);
        finishBootstrap(selected, id);
      },
    });
  }

  function openMap(field: ProviderMapField, target: "provider" | "model"): void {
    const index = drill();
    const id = modelId();
    if (!providers()[index]) return;
    const read = (): Record<string, unknown> | undefined => {
      const provider = providers()[index];
      const source = target === "provider" ? provider : provider?.models?.[id];
      if (!source) return undefined;
      return field === "headers" ? source.headers : source.body;
    };
    const write = (next: Record<string, unknown> | undefined): void => {
      if (target === "provider") ctrl.setProviderMap(index, field, next);
      else ctrl.setModelMap(index, id, field, next);
    };
    maps.open(
      field === "headers"
        ? {
            label: "headers",
            kind: "text",
            read,
            write,
            rejectKey: headerKeyProblem,
            rejectValue: headerValueProblem,
            suggest: () => headerSuggestions(providers()[index]!.kind),
            footnote: () => headersFootnote(target),
          }
        : {
            label: "body",
            kind: "json",
            read,
            write,
            rejectKey: bodyKeyProblem,
            suggest: bodySuggestions,
            footnote: (path) => bodyFootnote(providers()[index]!.kind, path),
          },
    );
  }

  const mapCell = (map: Record<string, unknown> | undefined): string => {
    const count = Object.keys(map ?? {}).length;
    return count === 0 ? glyph("emDash") : `${count} ${count === 1 ? "entry" : "entries"}`;
  };

  const context: ProvidersViewContext = {
    host,
    ctrl,
    catalog: deps.catalog,
    notify: deps.notify,
    editor,
    maps,
    bootstrap,
    manualBootstrapProvider,
    setManualBootstrapProvider,
    providers,
    current,
    sel,
    setSel,
    drill,
    setDrill,
    detailRow,
    setDetailRow,
    modelRow,
    setModelRow,
    modelId,
    setModelId,
    setPicker,
    subscriptionRows,
    openSubscription,
    subscriptionStatus,
    manageSubscription,
    startEdit,
    enterKey,
    manualModelEntry,
    finishBootstrap,
    openModelPicker,
    modelRemovalBlocked,
    openMap,
    mapCell,
  };
  const list = createProviderListLevel(context);
  const detail = createProviderDetailLevel(context);
  const model = createProviderModelLevel(context);

  onMount(() => {
    refreshSubscriptionStatuses();
    if (bootstrap && providers().length === 0) list.openAdd();
  });

  onCleanup(() => {
    const id = activeAttemptId;
    clearDevice();
    if (id !== undefined && deps.providerAuth !== undefined) {
      detachObserved("provider_subscription_unmount_cancel", () => deps.providerAuth!.cancel(id));
    }
  });

  function jumpToIssue(issue: { field: string; provider?: string }): void {
    if (host.level.depth() === 0) {
      if (issue.provider) {
        const index = providers().findIndex((provider) => provider.name === issue.provider);
        if (index >= 0) setSel(index);
      }
    } else if (host.level.depth() === 1 && issue.provider === current()?.name) {
      const label = PROVIDER_ISSUE_DETAIL_FIELD[issue.field];
      if (label !== undefined) setDetailRow(PROVIDER_DETAIL_FIELDS.indexOf(label));
    }
  }

  host.onSave(async () => {
    if (bootstrap) {
      const modelRef = ctrl.defaultModel();
      const separator = modelRef?.indexOf("/") ?? -1;
      const provider =
        separator > 0
          ? providers().find((item) => item.name === modelRef!.slice(0, separator))
          : undefined;
      const id = separator > 0 ? modelRef!.slice(separator + 1) : "";
      if (provider?.models?.[id] !== undefined) {
        finishBootstrap(provider, id);
        return;
      }
    }
    if ((await ctrl.save()) !== "validation") return;
    const validation = ctrl.validation();
    if (!validation.ok) jumpToIssue(validation.issues[0]!);
  });

  const specFor = (depth: number): LevelSpec => {
    if (maps.active()) return maps.levelSpec();
    if (depth === 0) return list.spec();
    if (depth === 1) return detail.spec();
    return model.spec();
  };
  bindLevelKeys({
    host,
    editor,
    suspend: () => picker() !== null,
    register: (enabled) =>
      registerLevel(host.interaction.keymap, { ...specFor(host.level.depth()), enabled }),
  });

  return (
    <LevelHost
      host={host}
      editor={editor}
      picker={picker}
      firstRunPicker={bootstrap}
      levels={[
        { title: list.title, body: list.body },
        { title: detail.title, body: detail.body },
        { when: () => maps.active(), title: "Providers", body: maps.Body },
        {
          when: () => !maps.active() && host.level.depth() >= 2,
          title: "Providers",
          body: model.body,
        },
      ]}
    />
  );
}
