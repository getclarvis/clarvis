import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type {
  ConfigService,
  ModelCatalogService,
  ProviderAuthService,
  SecretService,
  SubscriptionScheme,
} from "@clarvis/protocol";
import { createModelCatalogService } from "../models/model-catalog.ts";
import {
  createFileSecretStore,
  createSecretService,
  type SecretStore,
} from "../secrets/secret-store.ts";
import { SubscriptionManager, type SubscriptionManagerOptions } from "../subscriptions/manager.ts";
import { createFileSubscriptionStore } from "../subscriptions/store.ts";
import { createUnavailableProviderAuthService } from "../subscriptions/unavailable.ts";
import { createConfigService } from "./config-service.ts";
import type { ConfigStore } from "./config-store.ts";
import { createFileConfigStore } from "./file-config-store.ts";

/** Host-local administrative composition, independent of any execution placement. */
export interface CreateOperatorServicesOptions {
  workspaceRoot: string;
  /** Explicit operator-owned root; never inferred from a guest or inherited test environment. */
  globalDir: string;
  logger?: Logger;
  secretStore?: SecretStore;
  /** Host-only synchronous authority fence after a successful secret mutation, before its response. */
  onSecretChanged?: (name: string) => void;
  /** Disable local authentication for remote hosts, or supply bounded host subscription ports. */
  subscriptions?: false | SubscriptionManagerOptions;
}

/** Administrative services only. This object is host authority, not a serializable guest DTO. */
export interface OperatorServices {
  readonly config: ConfigService;
  readonly secrets: SecretService;
  readonly models: ModelCatalogService;
  readonly providerAuth: ProviderAuthService;
  /** Canonical validated file store for host-side projection and revision checks. */
  readonly configStore: ConfigStore;
  /** Host-only value lookup used while constructing provider SDK calls. */
  resolveRegistryKey(name: string): string | undefined;
  /** Host-only subscription request authority; its token never crosses the Container channel. */
  resolveSubscription: SubscriptionManager["resolve"] | undefined;
  /** Observe credential authority changes after the host store commits them. */
  onAuthorityChanged(
    listener: (
      change:
        { kind: "secret"; name: string } | { kind: "subscription"; scheme: SubscriptionScheme },
    ) => void,
  ): () => void;
  close(): Promise<void>;
}

/**
 * Compose configuration, names-only secrets, catalog and local subscription administration.
 * No execution host, plugin contribution, native domain store, provider process or watcher is built.
 * Catalog downloads and subscription authentication occur only on explicit service operations.
 * Secret values remain inside the host store and are never included in the returned data surface.
 * The caller owns admission and must not expose these operator services to a guest.
 */
export function createOperatorServices(options: CreateOperatorServicesOptions): OperatorServices {
  const logger = options.logger ?? NOOP_LOGGER;
  const configStore = createFileConfigStore({
    workspaceRoot: options.workspaceRoot,
    globalDir: options.globalDir,
    logger,
    extensionProfile: {
      resolvePlugins: () => [],
      workspaceTrustSurface: () => undefined,
    },
  });
  const config = createConfigService(configStore);
  const authorityListeners = new Set<
    (
      change:
        { kind: "secret"; name: string } | { kind: "subscription"; scheme: SubscriptionScheme },
    ) => void
  >();
  const authorityChanged = (
    change: { kind: "secret"; name: string } | { kind: "subscription"; scheme: SubscriptionScheme },
  ): void => {
    for (const listener of authorityListeners) listener(change);
  };
  const secretStore = options.secretStore ?? createFileSecretStore({ dir: options.globalDir });
  const secrets = createSecretService({
    path: () => secretStore.path(),
    read: () => secretStore.read(),
    set(name, value) {
      secretStore.set(name, value);
      options.onSecretChanged?.(name);
      authorityChanged({ kind: "secret", name });
    },
    delete(name) {
      secretStore.delete(name);
      options.onSecretChanged?.(name);
      authorityChanged({ kind: "secret", name });
    },
  });
  const baseCatalog = createModelCatalogService(options.globalDir, logger);
  const subscriptions =
    options.subscriptions === false
      ? undefined
      : new SubscriptionManager({
          ...options.subscriptions,
          store:
            options.subscriptions?.store ?? createFileSubscriptionStore({ dir: options.globalDir }),
          logger: options.subscriptions?.logger ?? logger,
        });
  return {
    config,
    secrets,
    models: subscriptions?.catalogService(baseCatalog) ?? baseCatalog,
    providerAuth:
      subscriptions === undefined
        ? createUnavailableProviderAuthService()
        : {
            list: () => subscriptions.list(),
            startDevice: (scheme) => subscriptions.startDevice(scheme),
            wait: (attemptId) => subscriptions.wait(attemptId),
            cancel: (attemptId) => subscriptions.cancel(attemptId),
            async disconnect(scheme) {
              await subscriptions.disconnect(scheme);
              authorityChanged({ kind: "subscription", scheme });
            },
          },
    configStore,
    resolveRegistryKey: (name) => secretStore.read().values[name] ?? process.env[name],
    resolveSubscription:
      subscriptions === undefined
        ? undefined
        : (scheme, signal, context) => subscriptions.resolve(scheme, signal, context),
    onAuthorityChanged(listener) {
      authorityListeners.add(listener);
      return () => authorityListeners.delete(listener);
    },
    async close() {
      authorityListeners.clear();
      await subscriptions?.close();
    },
  };
}
