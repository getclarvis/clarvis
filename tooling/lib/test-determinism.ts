import ts from "typescript";

export const DETERMINISM_MECHANISMS = [
  "positive-wait",
  "timer",
  "process-env-mutation",
  "process-platform-redefinition",
  "process-chdir",
  "math-random-assignment",
  "fake-timers",
  "before-all-mutation",
  "listener",
  "subprocess",
] as const;

export type DeterminismMechanism = (typeof DETERMINISM_MECHANISMS)[number];

export const DETERMINISM_CLASSIFICATIONS = [
  "migrate",
  "boundary-canary",
  "false-positive",
] as const;

export type DeterminismClassification = (typeof DETERMINISM_CLASSIFICATIONS)[number];

export interface TestDeterminismOccurrence {
  file: string;
  line: number;
  column: number;
  mechanism: DeterminismMechanism;
  identity: string;
  packageOwner: string;
  classification: DeterminismClassification | "unclassified";
  reason: string;
}

export interface TestDeterminismSource {
  file: string;
  source: string;
}

export interface TestDeterminismBaselineEntry {
  mechanism: DeterminismMechanism;
  file: string;
  identity: string;
  package_owner: string;
  classification: DeterminismClassification;
  reason: string;
}

export interface TestDeterminismBaseline {
  version: 1;
  entries: TestDeterminismBaselineEntry[];
}

export interface TestDeterminismBaselineResult {
  failures: string[];
  newOccurrences: TestDeterminismOccurrence[];
  staleEntries: TestDeterminismBaselineEntry[];
}

const SCRIPT_KINDS = new Map([
  [".tsx", ts.ScriptKind.TSX],
  [".jsx", ts.ScriptKind.JSX],
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
]);

const scriptKindFor = (file: string): ts.ScriptKind => {
  for (const [extension, kind] of SCRIPT_KINDS) {
    if (file.endsWith(extension)) return kind;
  }
  return ts.ScriptKind.TS;
};

const normalizePath = (file: string): string => file.replaceAll("\\", "/");

export function normalizeTestPath(file: string): string {
  return normalizePath(file).replace(/^\.\//, "");
}

export function packageOwnerOf(file: string): string {
  const normalized = normalizeTestPath(file);
  const match = /^packages\/([^/]+)(?:\/|$)/.exec(normalized);
  return match ? `@clarvis/${match[1]}` : "tooling";
}

const isAssignmentOperator = (operator: ts.SyntaxKind): boolean =>
  operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;

const isIdentifierNamed = (node: ts.Node | undefined, name: string): boolean =>
  !!node && ts.isIdentifier(node) && node.text === name;

const propertyName = (
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const argument = node.argumentExpression;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
};

const propertyOnIdentifier = (
  node: ts.Node | undefined,
  object: string,
  property: string,
): boolean =>
  !!node &&
  (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
  isIdentifierNamed(node.expression, object) &&
  propertyName(node) === property;

const isProcessEnv = (node: ts.Node | undefined): boolean =>
  propertyOnIdentifier(node, "process", "env");

const isProcessPlatform = (node: ts.Node | undefined): boolean =>
  propertyOnIdentifier(node, "process", "platform");

const isMathRandom = (node: ts.Node | undefined): boolean =>
  propertyOnIdentifier(node, "Math", "random");

const callLeafName = (node: ts.Expression): string | undefined => {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return propertyName(node);
  }
  return undefined;
};

const callRootName = (node: ts.Expression): string | undefined => {
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
};

const isCallNamed = (node: ts.CallExpression, names: ReadonlySet<string>): boolean => {
  const leaf = callLeafName(node.expression);
  return leaf !== undefined && names.has(leaf);
};

const literalNumber = (node: ts.Expression | undefined): number | undefined => {
  if (!node) return undefined;
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken)
  ) {
    const value = literalNumber(node.operand);
    return value === undefined
      ? undefined
      : node.operator === ts.SyntaxKind.MinusToken
        ? -value
        : value;
  }
  return undefined;
};

const positiveLiteral = (node: ts.Expression | undefined): boolean => {
  const value = literalNumber(node);
  return value !== undefined && value > 0;
};

const normalizeSnippet = (node: ts.Node): string => node.getText().replace(/\s+/g, " ").trim();

const enclosingContext = (node: ts.Node, source: ts.SourceFile): string => {
  const labels: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) {
      const name = current.name?.getText(source);
      if (name) labels.push(name);
    }
    if (ts.isCallExpression(current)) {
      const leaf = callLeafName(current.expression);
      if (
        leaf &&
        new Set(["beforeAll", "beforeEach", "afterAll", "afterEach", "describe", "test", "it"]).has(
          leaf,
        )
      ) {
        const title = current.arguments[0];
        const titleText = title && ts.isStringLiteralLike(title) ? `:${title.text}` : "";
        labels.push(`${leaf}${titleText}`);
      }
    }
    current = current.parent;
  }
  return labels.reverse().join("/") || "module";
};

const isInside = (node: ts.Node, ancestor: ts.Node): boolean => {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
};

const nearestFunction = (node: ts.Node): ts.FunctionLikeDeclaration | undefined => {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current as ts.FunctionLikeDeclaration;
    current = current.parent;
  }
  return undefined;
};

const containsCall = (root: ts.Node, predicate: (call: ts.CallExpression) => boolean): boolean => {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};

const containsLaterDirectCall = (
  root: ts.Node,
  predicate: (call: ts.CallExpression) => boolean,
  after: number,
): boolean => {
  let found = false;
  const visit = (node: ts.Node, isRoot = false): void => {
    if (found) return;
    if (!isRoot && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && node.getStart() > after && predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, (child) => visit(child));
  };
  visit(root, true);
  return found;
};

const FAKE_TIMER_NAMES = new Set(["useFakeTimers"]);
const REAL_TIMER_NAMES = new Set(["useRealTimers"]);
const LIFECYCLE_NAMES = new Set(["beforeEach", "beforeAll", "afterEach", "afterAll"]);
const LISTENER_NAMES = new Set(["listen"]);
const SUBPROCESS_NAMES = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);
const DIRECTORY_NAMES = new Set([
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "ensureDir",
  "ensureDirSync",
]);
const WATCHER_NAMES = new Set(["watch", "watchFile", "unwatchFile"]);

const isFakeTimerCall = (node: ts.CallExpression): boolean =>
  isCallNamed(node, FAKE_TIMER_NAMES) &&
  ["vi", "jest"].includes(callRootName(node.expression) ?? "");

const isRealTimerCall = (node: ts.CallExpression): boolean =>
  isCallNamed(node, REAL_TIMER_NAMES) &&
  ["vi", "jest"].includes(callRootName(node.expression) ?? "");

const isLifecycleCall = (node: ts.CallExpression, name: string): boolean =>
  ts.isIdentifier(node.expression) && node.expression.text === name;

const callbackOf = (node: ts.CallExpression): ts.FunctionLikeDeclaration | undefined => {
  const callback = node.arguments[0];
  return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ? callback
    : undefined;
};

const isListenerCall = (node: ts.CallExpression): boolean => isCallNamed(node, LISTENER_NAMES);

const isSubprocessCall = (node: ts.CallExpression): boolean => {
  if (!isCallNamed(node, SUBPROCESS_NAMES)) return false;
  if (ts.isIdentifier(node.expression)) return true;
  const root = callRootName(node.expression);
  return root === "Bun" || root === "child_process" || root === "node" || root === "cp";
};

const isDirectoryCall = (node: ts.CallExpression): boolean => isCallNamed(node, DIRECTORY_NAMES);

const isWatcherCall = (node: ts.CallExpression): boolean => isCallNamed(node, WATCHER_NAMES);

const stableIdentity = (
  mechanism: DeterminismMechanism,
  node: ts.Node,
  source: ts.SourceFile,
  ordinal: number,
): string =>
  `${mechanism}|${enclosingContext(node, source)}|${normalizeSnippet(node)}|${String(ordinal)}`;

/**
 * Analyze one test source file using the TypeScript AST.
 *
 * The parser deliberately sees structure rather than spelling, so comments and fixture strings do
 * not become findings and comparison operators cannot be mistaken for assignments.
 */
export function findTestDeterminismOccurrencesInFile(
  file: string,
  text: string,
): TestDeterminismOccurrence[] {
  const normalizedFile = normalizeTestPath(file);
  const parsed = ts.createSourceFile(
    normalizedFile,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(normalizedFile),
  );
  const occurrences: TestDeterminismOccurrence[] = [];
  const ordinals = new Map<string, number>();
  const add = (mechanism: DeterminismMechanism, node: ts.Node, reason: string): void => {
    const key = `${mechanism}|${enclosingContext(node, parsed)}|${normalizeSnippet(node)}`;
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    const { line, character } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    occurrences.push({
      file: normalizedFile,
      line: line + 1,
      column: character + 1,
      mechanism,
      identity: stableIdentity(mechanism, node, parsed, ordinal),
      packageOwner: packageOwnerOf(normalizedFile),
      classification: "unclassified",
      reason,
    });
  };

  const fakeCalls: ts.CallExpression[] = [];
  const realTimerCalls: ts.CallExpression[] = [];
  const lifecycleRestorers: ts.FunctionLikeDeclaration[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (
        node.expression &&
        propertyOnIdentifier(node.expression, "Bun", "sleep") &&
        positiveLiteral(node.arguments[0])
      ) {
        add("positive-wait", node, "Bun.sleep uses a positive literal delay");
      }
      const leaf = callLeafName(node.expression);
      if (leaf === "setTimeout" || leaf === "setInterval") {
        if (positiveLiteral(node.arguments[1]))
          add("timer", node, `${leaf} uses a positive literal delay`);
      }
      if (isFakeTimerCall(node)) fakeCalls.push(node);
      if (isRealTimerCall(node)) realTimerCalls.push(node);
      if (isListenerCall(node)) add("listener", node, "test opens a real listener");
      if (isSubprocessCall(node)) add("subprocess", node, "test starts a real subprocess");
      if (propertyOnIdentifier(node.expression, "process", "chdir")) {
        add("process-chdir", node, "test changes the process working directory");
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "defineProperty"
      ) {
        const [target, key] = node.arguments;
        if (
          isIdentifierNamed(target, "process") &&
          key &&
          ts.isStringLiteralLike(key) &&
          key.text === "platform"
        ) {
          add("process-platform-redefinition", node, "test redefines process.platform");
        }
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "assign" &&
        isIdentifierNamed(node.expression.expression, "Object") &&
        isProcessEnv(node.arguments[0])
      ) {
        add("process-env-mutation", node, "test copies values into process.env");
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "defineProperty" &&
        isProcessEnv(node.arguments[0])
      ) {
        add("process-env-mutation", node, "test defines a property on process.env");
      }

      if (isLifecycleCall(node, "beforeAll")) {
        const callback = callbackOf(node);
        if (callback) {
          const kinds = new Set<string>();
          const inspect = (child: ts.Node): void => {
            if (ts.isCallExpression(child)) {
              if (isDirectoryCall(child)) kinds.add("directory");
              if (isListenerCall(child)) kinds.add("listener");
              if (isWatcherCall(child)) kinds.add("watcher");
              if (isSubprocessCall(child)) kinds.add("subprocess");
            }
            ts.forEachChild(child, inspect);
          };
          inspect(callback.body ?? callback);
          if (kinds.size > 0) {
            add("before-all-mutation", node, `beforeAll creates ${[...kinds].sort().join(", ")}`);
          }
        }
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      if (
        isProcessEnv(node.left) ||
        ((ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
          isProcessEnv(node.left.expression))
      ) {
        add("process-env-mutation", node, "test writes to process.env");
      } else if (isProcessPlatform(node.left)) {
        add("process-platform-redefinition", node, "test redefines process.platform");
      } else if (isMathRandom(node.left)) {
        add("math-random-assignment", node, "test replaces Math.random");
      }
    }

    if (
      ts.isDeleteExpression(node) &&
      (isProcessEnv(node.expression) ||
        ((ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)) &&
          isProcessEnv(node.expression.expression)))
    ) {
      add("process-env-mutation", node, "test removes a process.env entry");
    }

    ts.forEachChild(node, visit);
  };

  visit(parsed);

  const lifecycleRestorerVisit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && LIFECYCLE_NAMES.has(callLeafName(node.expression) ?? "")) {
      const callback = callbackOf(node);
      if (callback && containsCall(callback.body ?? callback, isRealTimerCall))
        lifecycleRestorers.push(callback);
    }
    ts.forEachChild(node, lifecycleRestorerVisit);
  };
  lifecycleRestorerVisit(parsed);

  for (const fake of fakeCalls) {
    const fn = nearestFunction(fake);
    const restoredInFunction = fn
      ? containsLaterDirectCall(fn.body ?? fn, isRealTimerCall, fake.getStart())
      : false;
    const restoredInFinally = (() => {
      let current: ts.Node | undefined = fake.parent;
      while (current) {
        if (
          ts.isTryStatement(current) &&
          current.finallyBlock &&
          isInside(fake, current.tryBlock) &&
          containsCall(current.finallyBlock, isRealTimerCall)
        )
          return true;
        current = current.parent;
      }
      return false;
    })();
    const restoredAtModule = realTimerCalls.some(
      (real) => real.getStart() > fake.getStart() && nearestFunction(real) === undefined,
    );
    if (
      !restoredInFunction &&
      !restoredInFinally &&
      lifecycleRestorers.length === 0 &&
      !restoredAtModule
    ) {
      add("fake-timers", fake, "fake timers are not restored in the file lifecycle");
    }
  }

  occurrences.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.mechanism.localeCompare(right.mechanism),
  );
  return occurrences;
}

/** Analyze one file or a set of files and return a stable, source-order census. */
export function findTestDeterminismOccurrences(
  file: string,
  source: string,
): TestDeterminismOccurrence[];
export function findTestDeterminismOccurrences(
  files: readonly TestDeterminismSource[],
): TestDeterminismOccurrence[];
export function findTestDeterminismOccurrences(
  fileOrFiles: string | readonly TestDeterminismSource[],
  source?: string,
): TestDeterminismOccurrence[] {
  const files: readonly TestDeterminismSource[] =
    typeof fileOrFiles === "string" ? [{ file: fileOrFiles, source: source ?? "" }] : fileOrFiles;
  return files
    .flatMap(({ file, source: fileSource }) =>
      findTestDeterminismOccurrencesInFile(file, fileSource),
    )
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.column - right.column ||
        left.mechanism.localeCompare(right.mechanism),
    );
}

const occurrenceKey = (
  entry: Pick<TestDeterminismOccurrence, "file" | "mechanism" | "identity">,
): string => `${normalizeTestPath(entry.file)}|${entry.mechanism}|${entry.identity}`;

/** Compare a census with its explicit baseline. Every baseline row must still describe live code. */
export function checkTestDeterminismBaseline(
  occurrences: readonly TestDeterminismOccurrence[],
  baseline: TestDeterminismBaseline,
): TestDeterminismBaselineResult {
  const failures: string[] = [];
  const occurrenceByKey = new Map<string, TestDeterminismOccurrence>();
  for (const occurrence of occurrences) {
    const key = occurrenceKey(occurrence);
    if (occurrenceByKey.has(key)) failures.push(`duplicate occurrence identity: ${key}`);
    occurrenceByKey.set(key, occurrence);
  }
  const baselineKeys = new Set<string>();
  const staleEntries: TestDeterminismBaselineEntry[] = [];
  if (baseline.version !== 1)
    failures.push(`baseline version must be 1 (received ${String(baseline.version)})`);
  if (!Array.isArray(baseline.entries)) failures.push("baseline entries must be an array");
  const entries = Array.isArray(baseline.entries) ? baseline.entries : [];
  for (const candidate of entries) {
    if (!candidate || typeof candidate !== "object") {
      failures.push("baseline entry must be an object");
      continue;
    }
    const entry = candidate;
    if (
      typeof entry.file !== "string" ||
      typeof entry.identity !== "string" ||
      typeof entry.package_owner !== "string" ||
      typeof entry.mechanism !== "string" ||
      typeof entry.classification !== "string"
    ) {
      failures.push("baseline entry has invalid field types");
      continue;
    }
    if (entry.file.trim() === "") failures.push("baseline file is empty");
    if (entry.identity.trim() === "") failures.push("baseline identity is empty");
    if (entry.package_owner.trim() === "") failures.push("baseline package owner is empty");
    const key = occurrenceKey(entry);
    if (baselineKeys.has(key)) failures.push(`duplicate baseline identity: ${key}`);
    baselineKeys.add(key);
    if (!DETERMINISM_MECHANISMS.includes(entry.mechanism))
      failures.push(`unknown baseline mechanism: ${entry.mechanism}`);
    if (!DETERMINISM_CLASSIFICATIONS.includes(entry.classification))
      failures.push(`invalid baseline classification: ${entry.classification}`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "")
      failures.push(`baseline reason is empty: ${key}`);
    if (normalizeTestPath(entry.file) !== entry.file)
      failures.push(`baseline path is not normalized: ${entry.file}`);
    const occurrence = occurrenceByKey.get(key);
    if (!occurrence) {
      staleEntries.push(entry);
      failures.push(`stale baseline entry: ${key}`);
      continue;
    }
    if (entry.package_owner !== occurrence.packageOwner) {
      failures.push(
        `baseline package owner mismatch: ${key} (expected ${occurrence.packageOwner})`,
      );
    }
  }
  const newOccurrences = occurrences.filter(
    (occurrence) => !baselineKeys.has(occurrenceKey(occurrence)),
  );
  for (const occurrence of newOccurrences) {
    failures.push(`new unclassified occurrence: ${occurrenceKey(occurrence)}`);
  }
  return { failures, newOccurrences, staleEntries };
}

export function baselineFromOccurrences(
  occurrences: readonly TestDeterminismOccurrence[],
  classify: (occurrence: TestDeterminismOccurrence) => {
    classification: DeterminismClassification;
    reason: string;
  } = (occurrence) => ({
    classification:
      occurrence.mechanism === "listener" || occurrence.mechanism === "subprocess"
        ? "boundary-canary"
        : "migrate",
    reason:
      occurrence.mechanism === "listener" || occurrence.mechanism === "subprocess"
        ? "physical boundary canary required by the test"
        : "legacy occurrence scheduled for deterministic test migration",
  }),
): TestDeterminismBaseline {
  return {
    version: 1,
    entries: occurrences.map((occurrence) => {
      const result = classify(occurrence);
      return {
        mechanism: occurrence.mechanism,
        file: normalizeTestPath(occurrence.file),
        identity: occurrence.identity,
        package_owner: occurrence.packageOwner,
        classification: result.classification,
        reason: result.reason,
      };
    }),
  };
}
