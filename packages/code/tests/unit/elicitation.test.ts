import { expect, test } from "bun:test";
import type { ElicitRequestParams } from "../../src/adapters/elicit-types.ts";
import {
  acceptResult,
  buildContent,
  initialValues,
  missingRequired,
  parseElicitForm,
} from "../../src/adapters/elicitation.ts";

const askUserText: ElicitRequestParams = {
  message: "What should I name the file?",
  requestedSchema: {
    type: "object",
    properties: { response: { type: "string", description: "Your answer." } },
    required: ["response"],
  },
};

const askUserEnum: ElicitRequestParams = {
  message: "Which approach?",
  requestedSchema: {
    type: "object",
    properties: { response: { type: "string", enum: ["a", "b", "c"] } },
    required: ["response"],
  },
};

const softLimit: ElicitRequestParams = {
  message: "Used 90 of the soft tokens limit (100). Continue?",
  requestedSchema: {
    type: "object",
    properties: { continue: { type: "string", enum: ["continue", "stop"] } },
    required: ["continue"],
  },
};

const planReview: ElicitRequestParams = {
  message: "Approve the plan, request changes, or cancel?",
  requestedSchema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["approve", "request_changes", "cancel"] },
      feedback: { type: "string", description: "Optional notes." },
    },
    required: ["decision"],
  },
};

test("parseElicitForm: a plain string field → a required text field", () => {
  const form = parseElicitForm(askUserText);
  expect(form.mode).toBe("form");
  expect(form.fields).toHaveLength(1);
  expect(form.fields[0]).toMatchObject({ name: "response", kind: "text", required: true });
});

test("parseElicitForm: an enum → a select field with options", () => {
  const form = parseElicitForm(askUserEnum);
  expect(form.fields[0]!.kind).toBe("select");
  expect(form.fields[0]!.options.map((o) => o.value)).toEqual(["a", "b", "c"]);
});

test("parseElicitForm: plan-review yields an enum field + an optional text field, in order", () => {
  const form = parseElicitForm(planReview);
  expect(form.fields.map((f) => f.name)).toEqual(["decision", "feedback"]);
  expect(form.fields[0]).toMatchObject({ kind: "select", required: true });
  expect(form.fields[1]).toMatchObject({ kind: "text", required: false });
});

const guardSession: ElicitRequestParams = {
  message: "no allowed commands list configured\n\n$ rm -rf build",
  kind: "guard_confirm",
  detail: { command: "rm -rf build", cwd: "/work", reason: "no allowed commands list configured" },
  requestedSchema: {
    type: "object",
    properties: { decision: { type: "string", enum: ["deny", "allow", "allow_session"] } },
    required: ["decision"],
  },
};

test("parseElicitForm: guard decisions keep deny-first order and gain scope labels", () => {
  const form = parseElicitForm(guardSession);
  expect(form.fields[0]!.options).toEqual([
    { value: "deny", label: "deny" },
    { value: "allow", label: "allow once" },
    { value: "allow_session", label: "allow for this session" },
  ]);
  expect(initialValues(form.fields)).toEqual({ decision: "deny" });
});

test("parseElicitForm: the command detail rides the form; a blank command falls back to prose", () => {
  expect(parseElicitForm(guardSession).detail).toEqual({
    command: "rm -rf build",
    cwd: "/work",
    reason: "no allowed commands list configured",
  });
  expect(
    parseElicitForm({
      ...guardSession,
      detail: { command: "   ", cwd: "/work", reason: "no allowed commands list configured" },
    }).detail,
  ).toBeUndefined();
  expect(parseElicitForm(askUserEnum).detail).toBeUndefined();
});

test("parseElicitForm: url mode carries the url and no fields", () => {
  const url = parseElicitForm({
    mode: "url",
    message: "Authorize",
    url: "https://x",
  });
  expect(url.mode).toBe("url");
  expect(url.url).toBe("https://x");
  expect(url.fields).toEqual([]);
});

test("initialValues: a select seeds its first option; a text seeds empty", () => {
  const form = parseElicitForm(planReview);
  expect(initialValues(form.fields)).toEqual({ decision: "approve", feedback: "" });
});

test("initialValues: an approval gate can require an explicit choice", () => {
  const form = parseElicitForm(planReview);
  const seeded = initialValues(form.fields, "none");
  expect(seeded).toEqual({ decision: "", feedback: "" });
  expect(missingRequired(form.fields, seeded)).toEqual(["decision"]);
});

/**
 * The cross-package rule this pins. A choice field arrives with no `default`, so
 * whichever option the schema lists first is the one under the cursor and the
 * one a bare Enter submits. That makes enum order a *behavioural* contract for
 * whoever writes the schema — the plan-review gate lists `request_changes`
 * first precisely because of what happens here.
 */
test("initialValues: with no default, the first option is what a bare Enter would submit", () => {
  const form = parseElicitForm(planReview);
  const decision = form.fields.find((f) => f.name === "decision")!;
  expect(decision.default).toBeUndefined();
  expect(initialValues(form.fields).decision).toBe(decision.options[0]!.value);
});

test("initialValues: a boolean seeds its first option (yes) so it is not stuck unanswerable", () => {
  const form = parseElicitForm({
    message: "Overwrite the file?",
    requestedSchema: {
      type: "object",
      properties: { overwrite: { type: "boolean" } },
      required: ["overwrite"],
    },
  });
  expect(form.fields[0]).toMatchObject({ kind: "boolean" });
  const seeded = initialValues(form.fields);
  expect(seeded).toEqual({ overwrite: "true" });
  expect(missingRequired(form.fields, seeded)).toEqual([]);
});

test("missingRequired: an empty required field is reported; an optional one is not", () => {
  const form = parseElicitForm(planReview);
  expect(missingRequired(form.fields, { decision: "", feedback: "" })).toEqual(["decision"]);
  expect(missingRequired(form.fields, { decision: "approve", feedback: "" })).toEqual([]);
});

test("buildContent/acceptResult: only non-empty fields; ask_user answer round-trips", () => {
  const form = parseElicitForm(askUserText);
  expect(buildContent(form.fields, { response: "notes.md" })).toEqual({ response: "notes.md" });
  expect(acceptResult(form.fields, { response: "notes.md" })).toEqual({
    action: "accept",
    content: { response: "notes.md" },
  });
});

test("buildContent: soft-limit continue coerces to the enum string; empty optional dropped", () => {
  const form = parseElicitForm(softLimit);
  expect(buildContent(form.fields, { continue: "continue" })).toEqual({ continue: "continue" });
  const pr = parseElicitForm(planReview);
  expect(buildContent(pr.fields, { decision: "approve", feedback: "" })).toEqual({
    decision: "approve",
  });
});

test("buildContent: number and boolean fields coerce their string values", () => {
  const form = parseElicitForm({
    message: "tune",
    requestedSchema: {
      type: "object",
      properties: { n: { type: "number" }, flag: { type: "boolean" } },
      required: [],
    },
  });
  expect(buildContent(form.fields, { n: "42", flag: "true" })).toEqual({ n: 42, flag: true });
});
