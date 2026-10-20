import { expect, test } from "bun:test";
import { questionForm } from "./questions.ts";

test("each schema property becomes one question, in order: enums and oneOf pick one, arrays pick many, the rest is typed", () => {
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
        options: [
          { value: "ts", label: "TypeScript" },
          { value: "go", label: "Go" },
        ],
      },
      { key: "region", title: "region", description: "", kind: "single", options: [{ value: "eu", label: "Europe" }] },
      {
        key: "checks",
        title: "Checks",
        description: "",
        kind: "multi",
        options: [
          { value: "tests", label: "tests" },
          { value: "lint", label: "lint" },
        ],
      },
      { key: "owners", title: "owners", description: "", kind: "multi", options: [{ value: "ada", label: "Ada" }] },
      { key: "name", title: "Name", description: "", kind: "text", options: [] },
      { key: "replicas", title: "Replicas", description: "", kind: "text", options: [] },
      { key: "public", title: "Public?", description: "", kind: "text", options: [] },
    ],
  });
});

test("a URL-mode request, one without a schema and one without questions ask nothing", () => {
  const base = { sessionId: "bot_1", message: "Sign in" };
  expect(questionForm({ ...base, mode: "url", url: "https://example.com" })).toBeNull();
  expect(questionForm(base)).toBeNull();
  expect(questionForm({ ...base, requestedSchema: { type: "object", properties: {} } })).toBeNull();
});
