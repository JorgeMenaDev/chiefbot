import { expect, test } from "bun:test";
import type { QuestionForm } from "@chiefbot/contracts";
import { elicitationResult, questionForm } from "./questions.ts";

test("each schema property becomes one question, in order: enums and oneOf pick one, arrays pick many, a boolean picks yes or no, the rest is typed", () => {
  const form = questionForm({
    sessionId: "bot_1",
    message: "A few things first",
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        language: { type: "string", title: "Language", description: "For the new service", enum: ["ts", "go"], enumNames: ["TypeScript", "Go"] },
        region: { type: "string", oneOf: [{ const: "eu", title: "Europe" }] },
        checks: { type: "array", title: "Checks", items: { type: "string", enum: ["tests", "lint"] } },
        owners: { type: "array", items: { anyOf: [{ const: "ada", title: "Ada" }] } },
        name: { type: "string", title: "Name" },
        replicas: { type: "integer", title: "Replicas" },
        public: { type: "boolean", title: "Public?" },
        budget: { type: "number" },
      },
    },
  });

  expect(form).toEqual({
    message: "A few things first",
    questions: [
      {
        key: "language",
        title: "Language",
        description: "For the new service",
        kind: "single",
        type: "string",
        options: [
          { value: "ts", label: "TypeScript" },
          { value: "go", label: "Go" },
        ],
      },
      { key: "region", title: "region", description: "", kind: "single", type: "string", options: [{ value: "eu", label: "Europe" }] },
      {
        key: "checks",
        title: "Checks",
        description: "",
        kind: "multi",
        type: "string",
        options: [
          { value: "tests", label: "tests" },
          { value: "lint", label: "lint" },
        ],
      },
      { key: "owners", title: "owners", description: "", kind: "multi", type: "string", options: [{ value: "ada", label: "Ada" }] },
      { key: "name", title: "Name", description: "", kind: "text", type: "string", options: [] },
      { key: "replicas", title: "Replicas", description: "", kind: "text", type: "integer", options: [] },
      {
        key: "public",
        title: "Public?",
        description: "",
        kind: "single",
        type: "boolean",
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
      },
      { key: "budget", title: "budget", description: "", kind: "text", type: "number", options: [] },
    ],
  });
});

test("a URL-mode request, one without a schema and one without questions ask nothing", () => {
  const base = { sessionId: "bot_1", message: "Sign in" };
  expect(questionForm({ ...base, mode: "url", url: "https://example.com" })).toBeNull();
  expect(questionForm(base)).toBeNull();
  expect(questionForm({ ...base, requestedSchema: { type: "object", properties: {} } })).toBeNull();
});

test("answers reach the SDK under their questions' keys, as the content's own even for __proto__", () => {
  const question = (key: string) => ({ key, title: key, description: "", kind: "text" as const, type: "string" as const, options: [] });
  const form: QuestionForm = { message: "Keys", questions: [question("__proto__"), question("constructor"), question("replicas")] };

  const result = elicitationResult(form, { action: "accept", answers: ["a", "b", 3] });

  expect(result.action).toBe("accept");
  expect(Object.keys(result.content ?? {})).toEqual(["__proto__", "constructor", "replicas"]);
  expect(JSON.stringify(result.content)).toBe('{"__proto__":"a","constructor":"b","replicas":3}');
  expect(elicitationResult(form, { action: "decline" })).toEqual({ action: "decline" });
});
