import type { CopilotInstallationToken } from "@chiefbot/contracts";
import { systemClock, type Clock } from "./clock.ts";
import type { BotSession, Copilot } from "./copilot.ts";

// A turn should start on a token with at least this long left: one with less is renewed first.
const renewWithinMs = 20 * 60_000;
// A turn still running this long before its token expires is cut short and continued on a new one.
const continueBeforeMs = 5 * 60_000;

// What the agent is told when its turn continues on a new runtime.
const continuePrompt = "continue";

// A session that an organization pays for, on one-hour installation tokens.
// Each token needs a runtime of its own (copilot.ts), so renewing means a new
// runtime: fetch a token, close the session (which stops its runtime) and
// resume it on a new one, with the same session id, so the conversation is
// kept, and the model set again. That happens before a turn (or a model
// listing) on a token with under 20 minutes left, and in the middle of a turn
// that would outlive its token: five minutes before it expires, the turn is cut
// short and continues on the new runtime with "continue". The agent sees one
// turn: the cut-short turn's own end never reaches it. What the cut runtime
// waited on (a permission request) is gone with it: `onCut` hears of each cut,
// before the turn continues. A renewal that fails mid-turn ends the turn with a session.error.
export async function installationSession({
  copilot,
  token,
  clock = systemClock,
  onCut,
  ...options
}: Omit<Parameters<Copilot["openSession"]>[0], "auth"> & {
  copilot: Copilot;
  // A new installation token from control.
  token: () => Promise<CopilotInstallationToken>;
  clock?: Clock;
  // The running turn was cut short; its runtime is stopped.
  onCut?: () => void;
}): Promise<BotSession> {
  const handlers = new Set<Parameters<BotSession["on"]>[0]>();
  const publish: Parameters<BotSession["on"]>[0] = (event) => {
    for (const handler of handlers) handler(event);
  };
  let model: string | null = null;
  let expiresAt = 0;
  let current: { session: BotSession; unsubscribe: () => void } | null = null;
  // Cancels the running turn's continue timer.
  let cancelContinue: (() => void) | null = null;

  async function open() {
    const fresh = await token();
    const session = await copilot.openSession({ ...options, auth: { kind: "installation", token: fresh.token } });
    const unsubscribe = session.on((event) => {
      if (event.type === "session.idle" || event.type === "session.error") {
        cancelContinue?.();
        cancelContinue = null;
      }
      publish(event);
    });
    current = { session, unsubscribe };
    expiresAt = fresh.expiresAt;
    if (model !== null) await session.setModel(model);
    return session;
  }

  // Closes the session, stopping its runtime. Its last events never reach the agent.
  async function close() {
    const closing = current;
    current = null;
    closing?.unsubscribe();
    await closing?.session.disconnect();
  }

  // Runs `change` once every earlier one has settled.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(change: () => Promise<T>): Promise<T> {
    const result = queue.then(change);
    queue = result.catch(() => {});
    return result;
  }

  // The session on a token with time left, restarted on a new one when needed.
  // A failed renewal leaves none, so the next call tries again.
  const live = () =>
    serial(async () => {
      if (current && expiresAt - clock.now() > renewWithinMs) return current.session;
      await close();
      return open();
    });

  // Sends `prompt` and cuts the turn short before its token runs out, to continue it on a new one.
  async function start(session: BotSession, prompt: string) {
    await session.send(prompt);
    cancelContinue?.();
    cancelContinue = clock.setTimeout(() => void continueOnNewToken(), Math.max(0, expiresAt - continueBeforeMs - clock.now()));
  }

  function continueOnNewToken() {
    cancelContinue = null;
    return serial(async () => {
      const cut = current;
      try {
        current = null;
        cut?.unsubscribe();
        await cut?.session.abort();
        await cut?.session.disconnect();
        onCut?.();
        await start(await open(), continuePrompt);
      } catch (error) {
        const message = `Could not renew the organization's Copilot token mid-task: ${error instanceof Error ? error.message : String(error)}`;
        publish({ id: crypto.randomUUID(), parentId: null, timestamp: new Date().toISOString(), type: "session.error", data: { errorType: "query", message } });
      }
    });
  }

  await live();

  return {
    on(handler) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    send: async (prompt) => start(await live(), prompt),
    abort: async () => {
      cancelContinue?.();
      cancelContinue = null;
      await current?.session.abort();
    },
    async setModel(next) {
      await (await live()).setModel(next);
      model = next;
    },
    rpc: { model: { list: async () => (await live()).rpc.model.list() } },
    disconnect: () => serial(close),
  };
}
