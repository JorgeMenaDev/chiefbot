import type { BotSession, Copilot } from "./copilot.ts";

// A turn should not outlive its token: one with less than this left is renewed first.
const renewWithinMs = 20 * 60_000;

// A session that an organization pays for, on one-hour installation tokens.
// Each token needs a runtime of its own (copilot.ts), so before a turn (or a
// model listing) on a token with under 20 minutes left, it fetches a new
// token, closes the session, which stops its runtime, and resumes it on a new
// runtime: same session id, so the conversation is kept, and the model is set
// again. Never mid-turn: a turn longer than its token's time left fails when
// the token expires.
export async function installationSession({
  copilot,
  token,
  ...options
}: Omit<Parameters<Copilot["openSession"]>[0], "auth"> & {
  copilot: Copilot;
  // A new installation token from control, with its expiry in epoch milliseconds.
  token: () => Promise<{ token: string; expiresAt: number }>;
}): Promise<BotSession> {
  const handlers = new Set<Parameters<BotSession["on"]>[0]>();
  let model: string | null = null;
  let expiresAt = 0;
  let current: BotSession | null = null;

  async function open() {
    const fresh = await token();
    const session = await copilot.openSession({ ...options, auth: { kind: "installation", token: fresh.token } });
    session.on((event) => {
      for (const handler of handlers) handler(event);
    });
    current = session;
    expiresAt = fresh.expiresAt;
    if (model !== null) await session.setModel(model);
    return session;
  }

  // The session on a token with time left, restarted on a new one when needed.
  // One at a time; a failed renewal leaves none, so the next call tries again.
  let queue = Promise.resolve();
  function live(): Promise<BotSession> {
    const session = queue.then(async () => {
      if (current && expiresAt - Date.now() > renewWithinMs) return current;
      await current?.disconnect();
      current = null;
      return open();
    });
    queue = session.then(
      () => {},
      () => {},
    );
    return session;
  }
  await live();

  return {
    on(handler) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    send: async (prompt) => (await live()).send(prompt),
    async setModel(next) {
      await (await live()).setModel(next);
      model = next;
    },
    rpc: { model: { list: async () => (await live()).rpc.model.list() } },
    async disconnect() {
      await current?.disconnect();
      current = null;
    },
  };
}
