import { expect, test } from "bun:test";
import type { Question, QuestionForm } from "@chiefbot/contracts";
import { answerOf, answerText, draftOf, emptyAnswer, formResult, togglePick, typeAnswer } from "./questionAnswers.ts";

const options = [
  { value: "ts", label: "TypeScript" },
  { value: "go", label: "Go" },
];
const single: Question = { key: "language", title: "Language", description: "", kind: "single", type: "string", options };
const multi: Question = { key: "checks", title: "Checks", description: "", kind: "multi", type: "string", options };
const text: Question = { key: "name", title: "Name", description: "", kind: "text", type: "string", options: [] };

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

test("the form's answer needs every question answered, and lists them in the form's order", () => {
  const form: QuestionForm = { message: "Before I start", questions: [single, multi, text] };
  const draft = { step: 2, answers: [togglePick(single, emptyAnswer, "go"), togglePick(multi, emptyAnswer, "ts"), emptyAnswer] };

  expect(formResult(form, draft)).toBeNull();
  expect(formResult(form, { ...draft, answers: draft.answers.with(2, typeAnswer(emptyAnswer, "Atlas")) })).toEqual({
    action: "accept",
    answers: ["go", ["ts"], "Atlas"],
  });
});

test("a number or yes/no answer goes as its type when it reads as one, and as written when not", () => {
  const replicas: Question = { ...text, type: "integer" };
  const budget: Question = { ...text, type: "number" };
  const yesNo: Question = { ...single, type: "boolean", options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] };

  expect(answerOf(replicas, typeAnswer(emptyAnswer, " 3 "))).toBe(3);
  expect(answerOf(replicas, typeAnswer(emptyAnswer, "2.5"))).toBe("2.5");
  expect(answerOf(budget, typeAnswer(emptyAnswer, "-2.5"))).toBe(-2.5);
  expect(answerOf(budget, typeAnswer(emptyAnswer, "about 40"))).toBe("about 40");
  // Any number as JSON writes it, exponents included; text when it is not one, or not finite.
  expect(["1e-3", "-2.5E+2", "0", "1e400", "0x10", "007", "1."].map((typed) => answerOf(budget, typeAnswer(emptyAnswer, typed)))).toEqual([
    0.001,
    -250,
    0,
    "1e400",
    "0x10",
    "007",
    "1.",
  ]);
  expect(["1e3", "1e-3", "9007199254740993"].map((typed) => answerOf(replicas, typeAnswer(emptyAnswer, typed)))).toEqual([
    1000,
    "1e-3",
    "9007199254740993",
  ]);
  expect(answerOf(yesNo, togglePick(yesNo, emptyAnswer, "false"))).toBe(false);
  expect(answerOf(yesNo, typeAnswer(emptyAnswer, "only on Fridays"))).toBe("only on Fridays");
  expect(answerOf(yesNo, { ...togglePick(yesNo, emptyAnswer, "true"), comment: "for now" })).toBe("true — for now");
  expect(answerText(yesNo, false)).toBe("No");
  expect(answerText(replicas, 3)).toBe("3");
});

test("schema keys an object would inherit (constructor, toString, __proto__) are only labels", () => {
  const keyed = (key: string): Question => ({ ...text, key, title: key });
  const form: QuestionForm = { message: "Keys", questions: [keyed("constructor"), keyed("toString"), keyed("__proto__")] };
  const draft = draftOf(null, 3);

  expect(form.questions.map((question, i) => answerOf(question, draft.answers[i]))).toEqual([null, null, null]);
  expect(formResult(form, { ...draft, answers: draft.answers.map((answer, i) => typeAnswer(answer, `answer ${i}`)) })).toEqual({
    action: "accept",
    answers: ["answer 0", "answer 1", "answer 2"],
  });
});

test("an answer reads back with the options' labels", () => {
  expect(answerText(single, "ts — strict, please")).toBe("TypeScript — strict, please");
  expect(answerText(multi, ["ts", "go", "and a smoke run"])).toBe("TypeScript, Go, and a smoke run");
  expect(answerText(text, "Atlas")).toBe("Atlas");
});

test("a saved draft that no longer parses or fits the form starts the card afresh", () => {
  const fresh = { step: 0, answers: [emptyAnswer, emptyAnswer] };

  expect(draftOf('{"step":1,"answers":[{"picks":["ts"],"text":"","comment":""},{"picks":[],"text":"Atlas","comment":""}]}', 2)).toEqual({
    step: 1,
    answers: [
      { picks: ["ts"], text: "", comment: "" },
      { picks: [], text: "Atlas", comment: "" },
    ],
  });
  expect(draftOf('{"step":1,"answers":[{"picks":[],"text":"Atlas","comment":""}]}', 2)).toEqual(fresh);
  expect(draftOf('{"step":1,"answers":{"name":{"picks":[],"text":"Atlas","comment":""}}}', 2)).toEqual(fresh);
  expect(draftOf("not json", 2)).toEqual(fresh);
  expect(draftOf(null, 2)).toEqual(fresh);
});
