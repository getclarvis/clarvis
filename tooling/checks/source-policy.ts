import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { findModuleMockCalls, findUnclassifiedTestFiles } from "../lib/source-policy.ts";

// The suppression primitive is the only production location whose contract is
// to consume a rejection without another handler on this promise.
const baseline = new Map([["packages/capability/src/tasks.ts", 1]]);

async function sourceFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(child)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) result.push(child);
  }
  return result;
}

const sourceFilesToCheck = [];
const moduleMockFiles = [];
const packageTestFiles = [];
for (const pkg of await readdir("packages")) {
  const src = path.join("packages", pkg, "src");
  try {
    const sources = await sourceFiles(src);
    sourceFilesToCheck.push(...sources);
    moduleMockFiles.push(...sources);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const scope of ["tests", "tooling"]) {
    try {
      const files = await sourceFiles(path.join("packages", pkg, scope));
      moduleMockFiles.push(...files);
      if (scope === "tests") packageTestFiles.push(...files);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
moduleMockFiles.push(...(await sourceFiles("tooling")));

const failures = [];
const moduleMockLabel = ["mock", ".module()"].join("");
for (const file of sourceFilesToCheck) {
  const source = await readFile(file, "utf8");
  const count = source.match(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/g)?.length ?? 0;
  const allowed = baseline.get(file) ?? 0;
  if (count > allowed)
    failures.push(`${file}: ${count} empty promise catches (allowed ${allowed})`);
}
for (const file of moduleMockFiles) {
  const source = await readFile(file, "utf8");
  for (const finding of findModuleMockCalls(file, source)) {
    failures.push(
      `${finding.file}:${finding.line}:${finding.column}: ${moduleMockLabel} changes process-global module state`,
    );
  }
}
for (const file of findUnclassifiedTestFiles(packageTestFiles)) {
  failures.push(
    `${file}: test file must live under tests/{unit,component,contract,integration,architecture,e2e}`,
  );
}
if (failures.length > 0) {
  console.error(
    "Task-intent violations:\n" +
      failures.join("\n") +
      `\nUse dependency injection instead of ${moduleMockLabel}; use bestEffort, detachObserved, or suppressSecondaryRejection instead of empty catches.`,
  );
  process.exitCode = 1;
}
