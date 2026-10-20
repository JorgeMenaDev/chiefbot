import { expect, test } from "bun:test";
import { secretRedactor, turnEventRedactor } from "./secretRedactor.ts";

const key = "sk-live-4f9a2b7c1d";

test("a secret is hidden as it is, URL-encoded, and line by line when it has several lines", () => {
  const { redact } = secretRedactor([key, "p@ss w/rd!", "short\nlong-secret-content\nx"]);

  expect(redact(`key=${key}`)).toBe("key=***");
  expect(redact(`url=${encodeURIComponent("p@ss w/rd!")}&raw=p@ss w/rd!`)).toBe("url=***&raw=***");
  // A multi-line value's lines count alone, even when only one is long enough;
  // a line under 6 characters (`short`, `x`) does not.
  expect(redact("got long-secret-content, short and x")).toBe("got ***, short and x");
});

test("a secret base64-encoded with bytes before or after it is hidden, but for the few characters those bytes change", () => {
  const { redact, holds } = secretRedactor([key]);
  // The characters at each end may encode a neighbouring byte too (GitHub's runner, ADR 0297).
  const masked = /^[A-Za-z0-9+/]{0,4}\*\*\*[A-Za-z0-9+/=]{0,4}$/;

  for (const encoded of [btoa(key), btoa(`x${key}`), btoa(`xx${key}`), btoa(`${key}\n`), btoa(`u:${key}\n`)]) expect(redact(encoded)).toMatch(masked);
  expect(redact(btoa(key))).toBe("***");
  expect(holds(`body ${btoa(`xx${key}`)}`)).toBe(true);
});

test("overlapping secrets are hidden as one span, also when the text comes in chunks", () => {
  const { redact, stream } = secretRedactor(["prefix-sk", key]);
  const chunks = stream();

  expect(redact(`a prefix-sk-live-4f9a2b7c1d!`)).toBe("a ***!");
  // The first chunk ends with `prefix-sk` whole and the key not yet.
  expect([chunks.push("a prefix-sk-live-4f9a2b7c1"), chunks.push("d!"), chunks.end()].join("")).toBe("a ***!");
  expect(secretRedactor(["ab-ab-ab"]).redact("ab-ab-ab-ab.")).toBe("***.");
});

test("a secret under 6 characters is hidden only as it is", () => {
  const { redact } = secretRedactor(["p w!1"]);

  expect(redact(`p w!1 ${btoa("p w!1")} ${encodeURIComponent("p w!1")}`)).toBe(`*** ${btoa("p w!1")} p%20w!1`);
});

test("a secret split across chunks is still hidden: the end of the text waits for the next chunk, as long as the longest form less one", () => {
  const stream = secretRedactor([key]).stream();

  const out = [stream.push("token: sk-li"), stream.push("ve-4f9a"), stream.push(`2b7c1d done ${key.slice(0, 5)}`), stream.end()];

  expect(out.join("")).toBe(`token: *** done ${key.slice(0, 5)}`);
  expect(out.slice(0, 2)).toEqual(["", ""]);
});

test("with no secrets, text passes as it is", () => {
  const { redact, stream } = secretRedactor([]);
  const chunks = stream();

  expect([redact("anything"), chunks.push("a"), chunks.end()]).toEqual(["anything", "a", ""]);
});

test("an engineer's turn events hide its secrets, one split across a message's deltas and a tool row between them too", () => {
  const turn = turnEventRedactor(secretRedactor([key]));

  const out = [
    ...turn.event({ type: "text-delta", messageId: "m1", text: "Using sk-live-4f" }),
    ...turn.event({ type: "tool-call", toolCallId: "t1", name: `curl -H ${key}`, status: "running" }),
    ...turn.event({ type: "text-delta", messageId: "m1", text: "9a2b7c1d now." }),
    ...turn.event({ type: "error", message: `failed: ${key}` }),
    ...turn.event({ type: "done" }),
  ];

  expect(out).toEqual([
    { type: "tool-call", toolCallId: "t1", name: "curl -H ***", status: "running" },
    { type: "text-delta", messageId: "m1", text: "Using " },
    { type: "text-delta", messageId: "m1", text: "*** now." },
    { type: "error", message: "failed: ***" },
    { type: "done" },
  ]);
});

test("an engineer's messages keep their order: what one holds back goes when it is whole, or when the next one starts", () => {
  const turn = turnEventRedactor(secretRedactor([key]));

  const out = [
    ...turn.event({ type: "text-delta", messageId: "m1", text: "Running the tests." }),
    ...turn.messageDone("m1"),
    ...turn.event({ type: "tool-call", toolCallId: "t1", name: "bun test", status: "running" }),
    ...turn.event({ type: "text-delta", messageId: "m2", text: "Checking." }),
    ...turn.event({ type: "text-delta", messageId: "m3", text: "Nothing to change: the typo was fixed on main in #37." }),
    ...turn.event({ type: "done" }),
  ];

  expect(out.map((event) => (event.type === "text-delta" ? event.messageId : event.type))).toEqual(["m1", "tool-call", "m2", "m3", "m3", "done"]);
  expect(out[0]).toEqual({ type: "text-delta", messageId: "m1", text: "Running the tests." });
});
