import { expect, test } from "bun:test";
import { foldStage, foldStep, MAX_ATTACHMENT_BYTES, SendBotMessageRequest, SetupStep, type StackStage } from "./chat.ts";

// A file of `bytes` zero bytes, as the desktop sends it.
const file = (name: string, bytes = 1) => ({ name, mimeType: "text/plain", data: Buffer.alloc(bytes).toString("base64") });
const sends = (attachments: unknown[]) => SendBotMessageRequest.safeParse({ text: "hi", attachments }).success;

test("a message takes up to 5 files of up to 10 MB each, or none", () => {
  expect(sends([file("a.bin", MAX_ATTACHMENT_BYTES), file("b.txt"), file("c.txt"), file("d.txt"), file("e.txt")])).toBe(true);
  expect(SendBotMessageRequest.parse({ text: "hi" }).attachments).toEqual([]);
});

test.each([
  ["a sixth file", ["a", "b", "c", "d", "e", "f"].map((name) => file(`${name}.txt`))],
  ["a file over 10 MB", [file("big.bin", MAX_ATTACHMENT_BYTES + 1)]],
  ["a path for a name", [file("../notes.txt")]],
  ["two files with one name", [file("a.txt"), file("a.txt")]],
  ["a type that is not a MIME type", [{ ...file("a.txt"), mimeType: "text/plain\r\nx-evil: 1" }]],
  ["bytes that are not base64", [{ ...file("a.txt"), data: "not base64!" }]],
])("%s is refused", (_case, attachments) => {
  expect(sends(attachments)).toBe(false);
});

test("a stack's stages fold by which stage each is, not by its label: Build, a template stage labelled Build and two labelled alike keep a row each", () => {
  const report = (id: StackStage["id"], label: string, state: StackStage["state"], at: number): StackStage => ({ id, label, state, log: "", at });
  const reports = [
    ...[report("build", "Build", "waiting", 1), report(0, "Build", "waiting", 1), report(1, "API", "waiting", 1), report(2, "API", "waiting", 1)],
    ...[report("build", "Build", "running", 1), report("build", "Build", "passed", 5), report(0, "Build", "running", 5), report(0, "Build", "passed", 6)],
    ...[report(1, "API", "running", 6), report(1, "API", "failed", 9)],
  ];

  const rows = reports.reduce(foldStage, []);

  expect(rows.map(({ id, label, state, startedAt, endedAt }) => [id, label, state, startedAt, endedAt])).toEqual([
    ["build", "Build", "passed", 1, 5],
    [0, "Build", "passed", 5, 6],
    [1, "API", "failed", 6, 9],
    [2, "API", "waiting", null, null],
  ]);
});

test("a setup step's end takes the place of its start, and a step stored before steps had times has none", () => {
  const clone: SetupStep = { step: "clone", command: "git clone https://github.com/octo-org/shop.git shop", exitCode: null, log: "", startedAt: 1_000, endedAt: null };
  const cloned: SetupStep = { ...clone, exitCode: 0, log: "Cloning into 'shop'...\n", endedAt: 3_000 };
  const install: SetupStep = { step: "setup", command: "bun install", exitCode: null, log: "", startedAt: 3_000, endedAt: null };

  expect([clone, cloned, install].reduce(foldStep, [])).toEqual([cloned, install]);
  expect(SetupStep.parse({ step: "setup", command: "bun install", exitCode: 0, log: "" })).toMatchObject({ startedAt: null, endedAt: null });
});
