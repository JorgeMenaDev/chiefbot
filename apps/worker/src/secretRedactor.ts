import { SETUP_LOG_MAX, type TurnEvent } from "@chiefbot/contracts";

// Hides an engineer's secret values (its project's secrets, for one task) in
// what its worker sends control: setup logs, the agent's messages, tool rows and
// errors, so no transcript, task result or event keeps one.
//
// What it is for: accidents, such as `env` output, a test that logs a token, or
// an error that echoes a header. It cannot stop an agent that re-encodes a
// secret on purpose, since the agent holds the value. So it covers the forms
// GitHub Actions masks, and no more: each value as it is, URL-encoded, base64 (at
// each of the three byte alignments it can have inside longer base64), and each
// line of a multi-line value. A value under 6 characters is hidden only as it is.
// Each stretch of text that any form covers, overlaps included, becomes one `***`.
export type SecretRedactor = {
  redact(text: string): string;
  // Whether `text` holds any form of a secret.
  holds(text: string): boolean;
  // For text that comes in chunks: `push` gives back what may pass now and holds
  // back the end that could still start a form (as long as the longest form,
  // less one, and never more), so a form split across chunks is still found. A
  // find that reaches into that end goes out as `***` at once, and the stream
  // keeps masking it, with no second `***`, while finds continue it. `end` gives the rest.
  stream(): { push(chunk: string): string; end(): string };
};

// Shorter values, and shorter lines of a multi-line value, are too common to
// hide in other forms or line by line: one such as `}` would hide ordinary text.
const minLength = 6;

type Span = [start: number, end: number];

export function secretRedactor(values: string[]): SecretRedactor {
  const forms = [...new Set(values.flatMap(formsOf))].filter((form) => form.length > 0);
  const held = Math.max(1, ...forms.map((form) => form.length)) - 1;
  // Every place a form is found (overlaps too), merged into spans in order, with
  // the first `covered` characters counted as found. Each find costs its form's
  // length, so this is linear in the text, but for a long secret that overlaps
  // itself (`aaaa…`) printed over and over.
  const spansIn = (text: string, covered = 0) => {
    const found: Span[] = covered > 0 ? [[0, covered]] : [];
    for (const form of forms) {
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) found.push([at, at + form.length]);
    }
    const spans: Span[] = [];
    for (const [start, end] of found.sort(([a], [b]) => a - b)) {
      const last = spans.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else spans.push([start, end]);
    }
    return spans;
  };
  // `open`: a `***` already went out for a span the text starts in.
  const mask = (text: string, spans: Span[], open = false) => {
    let out = "";
    let from = 0;
    for (const [start, end] of spans) {
      out += text.slice(from, start) + (open && start === 0 ? "" : "***");
      from = end;
    }
    return out + text.slice(from);
  };
  const redact = (text: string) => mask(text, spansIn(text));
  return {
    redact,
    holds: (text) => spansIn(text).length > 0,
    stream() {
      // The end held back, and how much of its start is a find whose `***` went out.
      let rest = "";
      let covered = 0;
      return {
        push(chunk) {
          const text = rest + chunk;
          const spans = spansIn(text, covered);
          const cut = Math.max(0, text.length - held);
          const out = mask(
            text.slice(0, cut),
            spans.flatMap(([start, end]): Span[] => (start < cut ? [[start, Math.min(end, cut)]] : [])),
            covered > 0,
          );
          // The span that goes on past the cut, its `***` sent (or sent before).
          const open = spans.find(([start, end]) => end > cut && (start < cut || (start === 0 && covered > 0)));
          covered = open ? open[1] - cut : 0;
          rest = text.slice(cut);
          return out;
        },
        end() {
          const out = mask(rest, spansIn(rest, covered), covered > 0);
          rest = "";
          covered = 0;
          return out;
        },
      };
    },
  };
}

// A log of output that comes in chunks: each secret hidden as the text comes
// (one split across chunks too), and only then cut to its last SETUP_LOG_MAX
// characters, so no cut leaves a piece of one. `end` gives the log. An engineer's
// setup steps (engineerSetup.ts) and control's stack stages keep theirs this way.
export function redactedLog({ stream }: SecretRedactor) {
  const hidden = stream();
  let text = "";
  const keep = (more: string) => (text = (text + more).slice(-SETUP_LOG_MAX));
  return { push: (chunk: string) => void keep(hidden.push(chunk)), end: () => keep(hidden.end()) };
}

// An engineer's turn events with its secrets hidden in every text they carry.
// The message being written streams through the redactor, so a secret split
// across its deltas is still hidden, even around a tool row between them. What
// it holds back follows when the message is whole (`messageDone`, on the SDK's
// assistant.message), when the next message starts, or before the turn's error
// or done. So messages keep their order, each before the tool rows after it.
// Each call returns the events to send, in order: none while a delta is held.
export type TurnEventRedactor = { event(event: TurnEvent): TurnEvent[]; messageDone(messageId: string): TurnEvent[] };

export function turnEventRedactor({ redact, stream }: SecretRedactor): TurnEventRedactor {
  let current: { messageId: string; text: ReturnType<SecretRedactor["stream"]> } | null = null;
  const finish = (): TurnEvent[] => {
    if (!current) return [];
    const { messageId, text } = current;
    current = null;
    const last = text.end();
    return last ? [{ type: "text-delta", messageId, text: last }] : [];
  };
  return {
    messageDone: (messageId) => (current?.messageId === messageId ? finish() : []),
    event(event) {
      switch (event.type) {
        case "text-delta": {
          const before = current?.messageId === event.messageId ? [] : finish();
          current ??= { messageId: event.messageId, text: stream() };
          const text = current.text.push(event.text);
          return text ? [...before, { ...event, text }] : before;
        }
        case "status":
          return [{ ...event, text: redact(event.text) }];
        case "tool-call":
          return [{ ...event, name: redact(event.name) }];
        case "approval-request":
          return [{ ...event, detail: redact(event.detail) }];
        case "setup-step":
          return [{ ...event, step: { ...event.step, command: redact(event.step.command), log: redact(event.step.log).slice(-SETUP_LOG_MAX) } }];
        case "setup-done":
          return [{ ...event, instructions: event.instructions.map(redact), skills: event.skills.map(redact) }];
        // No text of the agent's in these. An engineer asks no questions (worker.ts).
        case "approval-withdrawn":
        case "question-request":
        case "question-withdrawn":
          return [event];
        case "error":
          return [...finish(), { ...event, message: redact(event.message) }];
        case "done":
          return [...finish(), event];
      }
    },
  };
}

// The forms of one value to hide (see above).
function formsOf(value: string): string[] {
  if (value.length < minLength) return [value];
  const bytes = Buffer.from(value);
  // Base64 of the value from each byte alignment on, less the end characters
  // that the bytes after it would change (GitHub's runner, ADR 0297).
  const aligned = [0, 1, 2].map((skip) => {
    const base64 = bytes.subarray(skip).toString("base64");
    return base64.endsWith("=") ? base64.replace(/=+$/, "").slice(0, -1) : base64;
  });
  // Whether a value has several lines is decided before short lines drop out.
  const lines = value.includes("\n")
    ? value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length >= minLength)
    : [];
  return [value, encodeURIComponent(value), bytes.toString("base64"), ...aligned, ...lines];
}
