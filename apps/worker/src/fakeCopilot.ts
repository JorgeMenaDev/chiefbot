import type { SessionEvent } from "@github/copilot-sdk";
import type { BotSession, Copilot } from "./copilot.ts";

// A fake Copilot SDK for tests. Each send() plays a script of real-shaped SDK
// session events. The default script echoes the prompt with one tool call.
// A script is an async generator, so a test can pause a turn halfway.
export type FakeScript = (prompt: string) => AsyncGenerator<SessionEvent>;

export function fakeCopilot({ script = echo }: { script?: FakeScript } = {}) {
  // The access token each opened session got from its gitHubTokenProvider.
  const tokens: string[] = [];
  // Ids of every session opened, in order (a resume counts again).
  const sessionIds: string[] = [];

  const copilot: Copilot = {
    async openSession({ sessionId, gitHubTokenProvider }) {
      const token = await gitHubTokenProvider({ host: "https://github.com", sessionId, reason: "initial" });
      if (token.kind === "token") tokens.push(token.accessToken);
      sessionIds.push(sessionId);
      const handlers = new Set<(event: SessionEvent) => void>();
      const session: BotSession = {
        on(handler) {
          handlers.add(handler);
          return () => void handlers.delete(handler);
        },
        async send(prompt) {
          // Like the SDK: send returns once the message is admitted; events follow.
          void (async () => {
            for await (const event of fake.script(prompt)) for (const handler of handlers) handler(event);
          })();
          return "user-msg";
        },
      };
      return session;
    },
  };

  const fake = { copilot, tokens, sessionIds, script };
  return fake;
}

export type FakeCopilot = ReturnType<typeof fakeCopilot>;

async function* echo(prompt: string): AsyncGenerator<SessionEvent> {
  yield sdk.intent("Answering");
  yield sdk.toolStart("tool-1", "echo", "Echo");
  yield sdk.toolComplete("tool-1", true);
  yield sdk.delta("msg-1", "You said: ");
  yield sdk.delta("msg-1", prompt);
  yield sdk.message("msg-1", `You said: ${prompt}`);
  yield sdk.idle();
}

// Builders for the SDK events the worker reads, with the envelope filled in.
let nextId = 0;
const envelope = () => ({ id: `event-${++nextId}`, parentId: null, timestamp: new Date().toISOString() });

export const sdk = {
  intent: (intent: string): SessionEvent => ({ ...envelope(), ephemeral: true, type: "assistant.intent", data: { intent } }),
  delta: (messageId: string, deltaContent: string, agentId?: string): SessionEvent => ({
    ...envelope(),
    ...(agentId === undefined ? {} : { agentId }),
    ephemeral: true,
    type: "assistant.message_delta",
    data: { messageId, deltaContent },
  }),
  message: (messageId: string, content: string): SessionEvent => ({
    ...envelope(),
    type: "assistant.message",
    data: { messageId, content },
  }),
  toolStart: (toolCallId: string, toolName: string, toolTitle?: string): SessionEvent => ({
    ...envelope(),
    type: "tool.execution_start",
    data: { toolCallId, toolName, ...(toolTitle === undefined ? {} : { toolTitle }) },
  }),
  toolComplete: (toolCallId: string, success: boolean): SessionEvent => ({
    ...envelope(),
    type: "tool.execution_complete",
    data: { toolCallId, success },
  }),
  error: (message: string): SessionEvent => ({
    ...envelope(),
    type: "session.error",
    data: { errorType: "query", message },
  }),
  idle: (): SessionEvent => ({ ...envelope(), ephemeral: true, type: "session.idle", data: {} }),
};
