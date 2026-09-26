import type { AnalysisLimit } from "./types.ts";

/** A bounded proof of literal POSIX argv segments. */
export interface ShellAnalysis {
  segments: string[][];
  limit: AnalysisLimit;
}

const MAX_BYTES = 16_384;
const MAX_DEPTH = 8;
const CONTROL = new Set([
  "if",
  "then",
  "else",
  "fi",
  "for",
  "while",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "{",
  "}",
]);

/** Parse a conservative literal shell subset without executing a shell. */
export function analyzeShell(command: string, depth = 0): ShellAnalysis {
  if (Buffer.byteLength(command) > MAX_BYTES) return { segments: [], limit: "bytes" };
  if (depth >= MAX_DEPTH) return { segments: [], limit: "depth" };
  const segments: string[][] = [];
  let segment: string[] = [];
  let word = "";
  let active = false;
  let quote: "single" | "double" | undefined;
  const pushWord = () => {
    if (active) segment.push(word);
    word = "";
    active = false;
  };
  const pushSegment = () => {
    pushWord();
    if (segment.length === 0) return false;
    segments.push(segment);
    segment = [];
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\" && quote !== "single") {
      const next = command[++i];
      if (next === undefined || next === "\n") return { segments: [], limit: "syntax" };
      word += next;
      active = true;
      continue;
    }
    if (ch === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      active = true;
      continue;
    }
    if (ch === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      active = true;
      continue;
    }
    if (quote !== "single" && (ch === "$" || ch === "`")) return { segments: [], limit: "syntax" };
    if (quote === undefined && ch === "#" && !active) {
      if (command.includes("\n", i)) return { segments: [], limit: "syntax" };
      break;
    }
    if (quote === undefined && /[<>*?[\]{}()\n]/.test(ch)) return { segments: [], limit: "syntax" };
    if (quote === undefined && /\s/.test(ch)) {
      pushWord();
      continue;
    }
    if (quote === undefined && (ch === ";" || ch === "|" || ch === "&")) {
      const next = command[i + 1];
      if (ch === "&" && next !== "&") return { segments: [], limit: "syntax" };
      if ((ch === "|" || ch === "&") && next === ch) i++;
      if (!pushSegment()) return { segments: [], limit: "syntax" };
      continue;
    }
    word += ch;
    active = true;
  }
  if (quote !== undefined || !pushSegment()) return { segments: [], limit: "syntax" };
  if (
    segments.some(
      (argv) =>
        CONTROL.has(argv[0]!) ||
        (!["env", "sudo"].includes(argv[0]!) &&
          argv.some((value) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(value))),
    )
  ) {
    return { segments: [], limit: "syntax" };
  }
  const unwrapped: string[][] = [];
  for (const argv of segments) {
    const shell = argv[0]?.split("/").at(-1);
    if (
      (shell === "sh" || shell === "bash" || shell === "zsh") &&
      (argv[1] === "-c" || argv[1] === "-lc") &&
      argv.length === 3
    ) {
      const nested = analyzeShell(argv[2]!, depth + 1);
      if (nested.limit !== "none") return nested;
      unwrapped.push(...nested.segments);
    } else {
      unwrapped.push(argv);
    }
  }
  return { segments: unwrapped, limit: "none" };
}

/** Recover literal danger candidates from syntax that cannot yield a strict proof. */
export function dangerCandidates(command: string): string[][] {
  const candidates: string[][] = [];
  const tokens: string[] = [];
  let word = "";
  let quote: "single" | "double" | undefined;
  const flush = () => {
    if (word) tokens.push(word);
    word = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\" && quote !== "single") {
      const next = command[++i];
      if (next !== undefined) word += next;
    } else if (ch === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
    } else if (ch === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
    } else if (quote === undefined && ch === "#" && word.length === 0) {
      if (tokens.length) {
        candidates.push([...tokens]);
        tokens.length = 0;
      }
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (quote === undefined && /\s/.test(ch)) {
      flush();
    } else if (quote === undefined && /[;&|()<>$`]/.test(ch)) {
      flush();
      if (tokens.length) {
        candidates.push([...tokens]);
        tokens.length = 0;
      }
    } else {
      word += ch;
    }
  }
  flush();
  if (tokens.length) candidates.push(tokens);
  return candidates;
}
