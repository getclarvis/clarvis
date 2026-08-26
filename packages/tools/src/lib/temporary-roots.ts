import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

interface TemporaryTemplateSnapshot {
  parent: string;
  matcher: RegExp;
  before: ReadonlySet<string>;
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function words(source: string): string[] {
  return [...source.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g)].map((match) => {
    const value = match[0];
    return value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  });
}

function invocationTemplates(command: string): string[] {
  const invocations = [...command.matchAll(/\$\(\s*mktemp\b([^)]*)\)/g)].map(
    (match) => match[1] ?? "",
  );
  for (const segment of command.split(/&&|\|\||[;|]/)) {
    const argv = words(segment.trim());
    if (basename(argv[0] ?? "") === "mktemp") invocations.push(argv.slice(1).join(" "));
  }
  const templates: string[] = [];
  for (const invocation of invocations) {
    const argv = words(invocation);
    if (!argv.some((arg) => arg === "-d" || arg === "--directory" || /^-[^-]*d/.test(arg)))
      continue;
    const template = argv.find((arg) => isAbsolute(arg) && /X{3,}/.test(basename(arg)));
    if (template !== undefined) templates.push(resolve(template));
  }
  return [...new Set(templates)];
}

function templateMatcher(template: string): RegExp {
  const escaped = basename(template).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/X{3,}/g, "[A-Za-z0-9]+")}$`);
}

/** Snapshot explicit `mktemp -d /tmp/...XXXXXX` templates before a shell call. */
export function snapshotExplicitTemporaryDirectories(
  command: string,
): readonly TemporaryTemplateSnapshot[] {
  let systemTemp: string;
  try {
    systemTemp = realpathSync(tmpdir());
  } catch {
    return [];
  }
  const snapshots: TemporaryTemplateSnapshot[] = [];
  for (const template of invocationTemplates(command)) {
    const parent = dirname(template);
    let realParent: string;
    try {
      realParent = realpathSync(parent);
    } catch {
      continue;
    }
    if (!within(realParent, systemTemp)) continue;
    const matcher = templateMatcher(template);
    snapshots.push({
      parent: realParent,
      matcher,
      before: new Set(readdirSync(realParent).filter((name) => matcher.test(name))),
    });
  }
  return snapshots;
}

/** Return newly-created, owner-controlled directories matching prior snapshots. */
export function createdTemporaryDirectories(
  snapshots: readonly TemporaryTemplateSnapshot[],
): string[] {
  const owner = process.getuid?.();
  const created: string[] = [];
  for (const snapshot of snapshots) {
    let names: string[];
    try {
      names = readdirSync(snapshot.parent);
    } catch {
      continue;
    }
    for (const name of names) {
      if (snapshot.before.has(name) || !snapshot.matcher.test(name)) continue;
      const candidate = join(snapshot.parent, name);
      try {
        const linkStat = lstatSync(candidate);
        const stat = statSync(candidate);
        if (linkStat.isSymbolicLink() || !stat.isDirectory()) continue;
        if (owner !== undefined && stat.uid !== owner) continue;
        created.push(realpathSync(candidate));
      } catch {
        continue;
      }
    }
  }
  return [...new Set(created)];
}
