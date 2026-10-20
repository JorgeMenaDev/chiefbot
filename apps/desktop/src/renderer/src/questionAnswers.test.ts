import { expect, test } from "bun:test";
import type { Question, QuestionForm } from "@chiefbot/contracts";
import { answerOf, answerText, draftOf, emptyAnswer, formResult, togglePick, typeAnswer } from "./questionAnswers.ts";

const options = [
  { value: "ts", label: "TypeScript" },
  { value: "go", label: "Go" },
];
const single: Question = { key: "language", title: "Language", description: "", kind: "single", options };
const multi: Question = { key: "checks", title: "Checks", description: "", kind: "multi", options };
const text: Question = { key: "name", title: "Name", description: "", kind: "text", options: [] };

test("a pick is the answer; a comment keeps it, joined to a single pick and one more value of a multi pick", () => {
  const picked = togglePick(single, emptyAnswer, "ts");
  const both = togglePick(multi, togglePick(multi, emptyAnswer, "go"), "ts");

  expect(answerOf(single, picked)).toBe("ts");
  expect(answerOf(single, { ...picked, comment: " strict, please " })).toBe("ts — strict, please");
  expect(answerOf(multi, both)).toEqual(["ts", "go"]);
  expect(answerOf(multi, { ...both, comment: "and a smoke run" })).toEqual(["ts", "go", "and a smoke run"]);
  expect(answerOf(multi, togglePick(multi, both, "go"))).toEqual(["ts"]);
});

test("a typed answer replaces the picks, and a pick clears it; a comment alone is no answer", () => {
  const other = typeAnswer(togglePick(single, emptyAnswer, "ts"), "Rust");

  expect(answerOf(single, other)).toBe("Rust");
  expect(answerOf(multi, typeAnswer(togglePick(multi, emptyAnswer, "go"), "Zig"))).toEqual(["Zig"]);
  expect(answerOf(single, togglePick(single, other, "go"))).toBe("go");
  expect(answerOf(single, { ...emptyAnswer, comment: "no idea" })).toBeNull();
  expect(answerOf(text, typeAnswer(emptyAnswer, "  "))).toBeNull();
  expect(answerOf(text, typeAnswer(emptyAnswer, " Atlas\nservice "))).toBe("Atlas\nservice");
});

test("the form's answer needs every question answered", () => {
  const form: QuestionForm = { message: "Before I start", questions: [single, multi, text] };
  const draft = { step: 2, answers: { language: togglePick(single, emptyAnswer, "go"), checks: togglePick(multi, emptyAnswer, "ts") } };

  expect(formResult(form, draft)).toBeNull();
  expect(formResult(form, { ...draft, answers: { ...draft.answers, name: typeAnswer(emptyAnswer, "Atlas") } })).toEqual({
    action: "accept",
    content: { language: "go", checks: ["ts"], name: "Atlas" },
  });
});

test("an answer reads back with the options' labels", () => {
  expect(answerText(single, "ts — strict, please")).toBe("TypeScript — strict, please");
  expect(answerText(multi, ["ts", "go", "and a smoke run"])).toBe("TypeScript, Go, and a smoke run");
  expect(answerText(text, "Atlas")).toBe("Atlas");
});

test("a saved draft that no longer parses starts the card afresh", () => {
  expect(draftOf('{"step":1,"answers":{"name":{"picks":[],"text":"Atlas","comment":""}}}')).toEqual({
    step: 1,
    answers: { name: { picks: [], text: "Atlas", comment: "" } },
  });
  expect(draftOf("not json")).toEqual({ step: 0, answers: {} });
  expect(draftOf(null)).toEqual({ step: 0, answers: {} });
});
