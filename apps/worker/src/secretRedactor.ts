import { SETUP_LOG_MAX, type TurnEvent } from "@chiefbot/contracts";

// Hides an engineer's secret values (its project's secrets, for one task) in
// what its worker sends control: setup logs, the agent's messages, tool rows and
// errors, so no transcript, task result or event keeps one. Each value counts
// in its common forms: as it is, base64 (with or without its padding), URL-encoded, and
// each line of 8 or more characters of a value that has several. Each form found
// becomes `***`.
export type SecretRedactor = {
  redact(text: string): string;
  // Whether `text` holds any form of a secret.
  holds(text: string): boolean;
  // For text that comes in chunks: `push` gives back what may pass now and holds
  // back the end that could still start a form (as long as the longest form,
  // less one), so a form split across chunks is still found; `end` gives the rest.
  stream(): { push(chunk: string): string; end(): string };
};

// A line of a multi-line secret shorter than this is not hidden alone: it
// reveals little, and one such as `}` would hide common text.
const lineMin = 8;

export function secretRedactor(values: string[]): SecretRedactor {
  const forms = [...new Set(values.flatMap(formsOf))].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
  // Longest first, so where two forms start at one place the longer one is hidden.
  const pattern = forms.length === 0 ? null : new RegExp(forms.map(escapeRegExp).join("|"), "g");
  const held = (forms[0]?.length ?? 1) - 1;
  const redact = (text: string) => (pattern ? text.replace(pattern, "***") : text);
  return {
    redact,
    holds: (text) => pattern !== null && text.search(pattern) !== -1,
    stream() {
      let rest = "";
      return {
        push(chunk) {
          if (!pattern) return chunk;
          const text = rest + chunk;
          let cut = Math.max(0, text.length - held);
          // A form found whole across the cut passes with what comes before it.
          for (const match of text.matchAll(pattern)) {
            if (match.index < cut && match.index + match[0].length > cut) cut = match.index + match[0].length;
          }
          rest = text.slice(cut);
          return redact(text.slice(0, cut));
        },
        end() {
          const last = rest;
          rest = "";
          return redact(last);
        },
      };
    },
  };
}

// An engineer's turn events with its secrets hidden in every text they carry.
// A message's deltas stream through the redactor, so a secret split across them
// is still hidden; what a message holds back follows (as one more delta of it)
// before the turn's next event other than a delta or status, by when the message
// is over. Returns the events to send, in order: none while a delta is held.
export function turnEventRedactor({ redact, stream }: SecretRedactor) {
  const messages = new Map<string, ReturnType<SecretRedactor["stream"]>>();
  const rest = (): TurnEvent[] => {
    const deltas = [...messages].flatMap(([messageId, message]): TurnEvent[] => {
      const text = message.end();
      return text ? [{ type: "text-delta", messageId, text }] : [];
    });
    messages.clear();
    return deltas;
  };
  return (event: TurnEvent): TurnEvent[] => {
    switch (event.type) {
      case "text-delta": {
        const message = messages.get(event.messageId) ?? stream();
        messages.set(event.messageId, message);
        const text = message.push(event.text);
        return text ? [{ ...event, text }] : [];
      }
      // An intent can come between a message's deltas.
      case "status":
        return [{ ...event, text: redact(event.text) }];
      case "tool-call":
        return [...rest(), { ...event, name: redact(event.name) }];
      case "error":
        return [...rest(), { ...event, message: redact(event.message) }];
      case "approval-request":
        return [...rest(), { ...event, detail: redact(event.detail) }];
      case "setup-step":
        return [...rest(), { ...event, step: { ...event.step, command: redact(event.step.command), log: redact(event.step.log).slice(-SETUP_LOG_MAX) } }];
      case "setup-done":
        return [...rest(), { ...event, instructions: event.instructions.map(redact), skills: event.skills.map(redact) }];
      // No text of the agent's in these. An engineer asks no questions (worker.ts).
      case "approval-withdrawn":
      case "question-request":
      case "question-withdrawn":
      case "done":
        return [...rest(), event];
    }
  };
}

function formsOf(value: string): string[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= lineMin);
  const base64 = Buffer.from(value).toString("base64");
  return [value, base64, base64.replace(/=+$/, ""), encodeURIComponent(value), ...(lines.length > 1 ? lines : [])];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
