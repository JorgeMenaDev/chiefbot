import { expect, test } from "bun:test";
import { secretRedactor, turnEventRedactor } from "./secretRedactor.ts";

const key = "sk-live-4f9a2b7c1d";
const pem = "-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9\nQ0x8sV2Lr7Yt\n}\n-----END KEY-----";

test("a secret is hidden as it is, in base64, URL-encoded, and line by line when it has several", () => {
  const { redact, holds } = secretRedactor([key, "p@ss w/rd!", pem]);

  expect(redact(`key=${key}; b64=${btoa(key)}`)).toBe("key=***; b64=***");
  expect(redact(`url=${encodeURIComponent("p@ss w/rd!")}&raw=p@ss w/rd!`)).toBe("url=***&raw=***");
  // Each line of 8 or more characters counts alone; a short one such as `}` would hide common text.
  expect(redact("got MIIBOgIBAAJBAKj34GkxFhD9 and Q0x8sV2Lr7Yt in {braces}")).toBe("got *** and *** in {braces}");
  expect([holds(`body ${btoa(key)}`), holds("nothing here")]).toEqual([true, false]);
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

test("an engineer's turn events hide its secrets, a message's split across its deltas, the rest of a message following before the next other event", () => {
  const events = turnEventRedactor(secretRedactor([key]));

  const out = [
    ...events({ type: "text-delta", messageId: "m1", text: "Using sk-live-4f" }),
    ...events({ type: "status", text: `Calling with ${key}` }),
    ...events({ type: "text-delta", messageId: "m1", text: "9a2b7c1d now." }),
    ...events({ type: "tool-call", toolCallId: "t1", name: `curl -H ${key}`, status: "running" }),
    ...events({ type: "error", message: `failed: ${key}` }),
    ...events({ type: "done" }),
  ];

  expect(out).toEqual([
    { type: "status", text: "Calling with ***" },
    { type: "text-delta", messageId: "m1", text: "Using " },
    { type: "text-delta", messageId: "m1", text: "*** now." },
    { type: "tool-call", toolCallId: "t1", name: "curl -H ***", status: "running" },
    { type: "error", message: "failed: ***" },
    { type: "done" },
  ]);
});
