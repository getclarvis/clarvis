import { existsSync, unwatchFile, watchFile } from "node:fs";
import {
  listSkillDirs,
  type SkillContent,
  type SkillInfo,
  type SkillRootInput,
} from "@clarvis/skills";
import type { Logger } from "@clarvis/capability";

export interface SkillPathWatcher {
  close(): void;
}

export interface SkillDriftNotice {
  name: string;
  scope: SkillInfo["scope"];
  source: SkillInfo["source"];
  path: string;
}

export function watchSkillPath(path: string, onChange: () => void): SkillPathWatcher {
  const listener = (
    current: { mtimeMs: number; ctimeMs: number; size: number; mode: number },
    previous: { mtimeMs: number; ctimeMs: number; size: number; mode: number },
  ): void => {
    if (
      current.mtimeMs === previous.mtimeMs &&
      current.ctimeMs === previous.ctimeMs &&
      current.size === previous.size &&
      current.mode === previous.mode
    )
      return;
    onChange();
  };
  watchFile(path, { persistent: false, interval: 1_000 }, listener);
  return { close: () => unwatchFile(path, listener) };
}

/** Owns watchers and change latches; snapshot replacement remains the manager's decision. */
export function createSkillCatalogMonitor(options: {
  roots: readonly SkillRootInput[];
  logger: Logger;
  watchSkillPath: (path: string, onChange: () => void) => SkillPathWatcher;
  onRefresh(): void;
  onPluginDrift?(notice: SkillDriftNotice): void;
}) {
  const { roots, logger } = options;
  const drifted = new Set<string>();
  const skillWatchers = new Map<string, SkillPathWatcher[]>();
  const rootWatchers = new Map<string, SkillPathWatcher>();
  const listeners = new Set<(retainOnFailure?: boolean) => void>();
  const capturedPaths = new Map<string, string>();
  let pending = false;
  let closed = false;
  let generation = 0;

  const requestRefresh = (): void => {
    if (closed || pending) return;
    pending = true;
    const owner = generation;
    queueMicrotask(() => {
      if (closed || owner !== generation) return;
      flushRefresh();
    });
  };

  const flushRefresh = (): void => {
    if (!pending || closed) return;
    options.onRefresh();
  };

  const observeRoots = (): void => {
    if (closed) return;
    const present = new Set<string>();
    for (const root of roots) {
      listSkillDirs(
        root.path,
        false,
        {
          logger,
          warningSink: (message) =>
            logger.warn(
              { event: "kernel.extension_profile.skill_discovery_notice", detail: message.trim() },
              "skill directory discovery reported a limitation",
            ),
        },
        undefined,
        {
          discovery: root.discovery,
          manifestName: root.manifestName,
          observeDirectory(path) {
            present.add(path);
            if (rootWatchers.has(path)) return;
            try {
              rootWatchers.set(
                path,
                options.watchSkillPath(path, () => {
                  if (!closed) requestRefresh();
                }),
              );
            } catch (error) {
              logger.warn(
                {
                  event: "kernel.extension_profile.skill_root_watch_unavailable",
                  path,
                  cause: error instanceof Error ? error.message : String(error),
                },
                "skill directory monitoring is unavailable; authorized writer notifications remain active",
              );
            }
          },
        },
      );
    }
    for (const [path, watcher] of rootWatchers) {
      if (!present.has(path) && !existsSync(path)) {
        watcher.close();
        rootWatchers.delete(path);
      }
    }
  };

  const resetSkillMonitoring = (): void => {
    for (const watchers of skillWatchers.values()) {
      for (const watcher of watchers) watcher.close();
    }
    skillWatchers.clear();
    drifted.clear();
  };

  const withdrawSkill = (skill: SkillInfo): void => {
    if (closed) return;
    if (!skill.source.startsWith("plugin:")) {
      requestRefresh();
      return;
    }
    if (drifted.has(skill.dir)) return;
    drifted.add(skill.dir);
    for (const watcher of skillWatchers.get(skill.dir) ?? []) watcher.close();
    skillWatchers.delete(skill.dir);
    logger.warn(
      {
        event: "kernel.extension_profile.skill_drift",
        skill: skill.name,
        scope: skill.scope,
        source: skill.source,
        path: skill.path,
      },
      "a changed skill was withdrawn from the process snapshot; runs remain available",
    );
    try {
      options.onPluginDrift?.({
        name: skill.name,
        scope: skill.scope,
        source: skill.source,
        path: skill.path,
      });
    } catch (error) {
      logger.warn(
        {
          event: "kernel.extension_profile.skill_drift_notice_failed",
          skill: skill.name,
          cause: error instanceof Error ? error.message : String(error),
        },
        "the host's skill drift notice callback failed",
      );
    }
  };

  const observeCatalog = (skills: readonly SkillContent[]): void => {
    if (closed) return;
    for (const skill of skills) {
      capturedPaths.set(`${skill.scope}/${skill.source}/${skill.name}`, skill.path);
      if (skillWatchers.has(skill.dir)) continue;
      const owner = generation;
      const onChange = (): void => {
        if (!closed && owner === generation) withdrawSkill(skill);
      };
      const paths = new Set<string>(
        skill.identityFiles ?? [skill.path, ...skill.resources.map((resource) => resource.path)],
      );
      const watchers: SkillPathWatcher[] = [];
      let lastError: unknown;
      for (const path of paths) {
        try {
          watchers.push(options.watchSkillPath(path, onChange));
        } catch (error) {
          lastError = error;
        }
      }
      if (watchers.length > 0) {
        skillWatchers.set(skill.dir, watchers);
      } else {
        logger.warn(
          {
            event: "kernel.extension_profile.skill_watch_unavailable",
            skill: skill.name,
            path: skill.dir,
            cause: lastError instanceof Error ? lastError.message : String(lastError),
          },
          "live skill drift monitoring is unavailable for one pinned skill",
        );
      }
    }
    observeRoots();
  };

  const publishRootsChanged = (retainOnFailure = false): boolean => {
    if (closed) return false;
    const previousGeneration = generation;
    generation++;
    const previousWatchers = new Map(skillWatchers);
    const previousDrift = new Set(drifted);
    const previousPaths = new Map(capturedPaths);
    if (retainOnFailure) {
      skillWatchers.clear();
      drifted.clear();
    } else resetSkillMonitoring();
    let success = true;
    for (const listener of [...listeners]) {
      try {
        listener(retainOnFailure);
      } catch (error) {
        success = false;
        logger.warn(
          {
            event: "kernel.extension_profile.skill_recomposition_failed",
            cause: error instanceof Error ? error.message : String(error),
          },
          "a skill catalog subscriber failed during an idle trust recomposition",
        );
        if (retainOnFailure) break;
      }
    }
    if (retainOnFailure) {
      if (success) {
        for (const watchers of previousWatchers.values())
          for (const watcher of watchers) watcher.close();
      } else {
        resetSkillMonitoring();
        for (const [path, watchers] of previousWatchers) skillWatchers.set(path, watchers);
        for (const path of previousDrift) drifted.add(path);
        capturedPaths.clear();
        for (const [key, path] of previousPaths) capturedPaths.set(key, path);
        generation = previousGeneration;
      }
    }
    if (success && pending) queueMicrotask(() => flushRefresh());
    return success;
  };

  return {
    requestRefresh,
    flushRefresh,
    consumeRefresh(): boolean {
      if (!pending || closed) return false;
      pending = false;
      return true;
    },
    observeRoots,
    observeCatalog,
    withdrawSkill,
    markStandaloneDrift(skill: SkillInfo): void {
      if (closed) return;
      drifted.add(skill.dir);
      requestRefresh();
    },
    skillAvailable: (skill: SkillInfo): boolean => !drifted.has(skill.dir),
    capturedPath: (ref: string): string | undefined => capturedPaths.get(ref),
    onRootsChanged(listener: (retainOnFailure?: boolean) => void): () => void {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publishRootsChanged,
    close(): void {
      if (closed) return;
      closed = true;
      generation++;
      resetSkillMonitoring();
      for (const watcher of rootWatchers.values()) watcher.close();
      rootWatchers.clear();
      listeners.clear();
      capturedPaths.clear();
    },
  };
}
