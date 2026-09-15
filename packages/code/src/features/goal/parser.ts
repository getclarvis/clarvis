/** A deterministic conversation command; objective text is never executed as a command. */
export type GoalCommand =
  | { kind: "show" | "edit" | "resume" | "cancel" | "clear" }
  | { kind: "pause"; running: boolean }
  | { kind: "create"; objective: string };

/** Parse only the explicit reserved verbs; -- introduces a literal objective. */
export function parseGoalCommand(raw: string): GoalCommand {
  const text = raw.trim();
  if (text === "") return { kind: "show" };
  const first = /^\S+/u.exec(text)![0];
  const rest = text.slice(first.length).trim();
  if (first === "pause") {
    if (rest !== "" && rest !== "--running") throw new Error("Usage: /goal pause [--running]");
    return { kind: "pause", running: rest === "--running" };
  }
  if (first === "edit" || first === "resume" || first === "cancel" || first === "clear") {
    if (rest !== "")
      throw new Error(`Usage: /goal ${first}. Use /goal -- <text> for a literal objective.`);
    return { kind: first };
  }
  const objective = first === "--" ? rest : text;
  if (first.startsWith("--") && first !== "--")
    throw new Error("Unknown goal option. Use /goal -- <text> for a literal objective.");
  if (!objective) throw new Error("An objective is required after /goal --.");
  if (objective.length > 16384)
    throw new Error("A goal objective may contain at most 16384 characters.");
  return { kind: "create", objective };
}
