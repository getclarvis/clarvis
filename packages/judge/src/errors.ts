/** Host composition faults are never semantic uncertainty or grounds for human fallback. */
export class JudgeArchitectureError extends Error {
  constructor() {
    super("Private Judge architecture contract failed.");
    this.name = "JudgeArchitectureError";
  }
}
