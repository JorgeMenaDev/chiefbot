import { afterEach, expect, test } from "bun:test";
import { TurnId, TurnKey } from "@chiefbot/contracts";
import { controlLink } from "./controlLink.ts";

// The link's connector forwarder against a fake control: it accepts the
// link's WebSocket and records the Authorization of each connector request.

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function setup() {
  const seen: Array<string | null> = [];
  const control = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      if (server.upgrade(req, { data: undefined })) return undefined;
      await req.arrayBuffer();
      seen.push(req.headers.get("authorization"));
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    },
    websocket: { message() {} },
  });
  const link = controlLink({ base: `${control.url.origin}/coordinator/project_1`, token: "credential", retryMs: 1000, parse: (json) => json, onMessage() {} });
  stops.push(link.stop, () => control.stop(true));
  const turn = link.begin(TurnId.parse("turn_1"), TurnKey.parse("key-1"));
  return { seen, link, turn, connector: link.connector(turn, "tracker") };
}

const call = { jsonrpc: "2.0", id: 1, method: "tools/list" };

test("the forwarder serves only a running turn's own secret: a turn id, no secret or a wrong one gets 401 and never reaches control", async () => {
  const { seen, link, turn, connector } = setup();
  const origin = new URL(connector.url).origin;
  const post = (url: string, headers: Record<string, string>) => fetch(url, { method: "POST", headers, body: JSON.stringify(call) });

  const byTurnId = await post(`${origin}/turns/${turn.turnId}/mcp/tracker`, {});
  const noSecret = await post(connector.url, {});
  const wrongSecret = await post(connector.url, { authorization: `Bearer ${"x".repeat(43)}` });
  const own = await post(connector.url, connector.headers);
  link.emit(turn.turnId, { type: "done" });
  const afterTurn = await post(connector.url, connector.headers);

  expect([byTurnId.status, noSecret.status, wrongSecret.status, own.status, afterTurn.status]).toEqual([401, 401, 401, 200, 401]);
  expect(seen).toEqual(["Bearer key-1"]);
  // The secret is long and random, and never leaves the computer.
  expect((connector.headers.authorization ?? "").length).toBeGreaterThanOrEqual("Bearer ".length + 43);
});

test("a request forwarded after a rekey carries the new key, even when its upload began before it", async () => {
  const { seen, link, turn, connector } = setup();
  let finish = () => {};
  const rest = new Promise<void>((resolve) => (finish = resolve));
  const [head, tail] = [JSON.stringify(call).slice(0, 10), JSON.stringify(call).slice(10)];
  const upload = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
      await rest;
      controller.enqueue(new TextEncoder().encode(tail));
      controller.close();
    },
  });

  const forwarded = fetch(connector.url, { method: "POST", headers: connector.headers, body: upload });
  await Bun.sleep(50);
  link.rekey(turn.turnId, TurnKey.parse("key-2"));
  finish();

  expect((await forwarded).status).toBe(200);
  expect(seen).toEqual(["Bearer key-2"]);
});

test("a turn's ended signal aborts when it is done, when control drops it, or when another turn begins", () => {
  const { link, turn } = setup();
  const running = turn.ended.aborted;

  link.emit(turn.turnId, { type: "done" });
  const second = link.begin(TurnId.parse("turn_2"), TurnKey.parse("key-2"));
  const third = link.begin(TurnId.parse("turn_3"), TurnKey.parse("key-3"));
  link.drop(third);

  expect([running, turn.ended.aborted, second.ended.aborted, third.ended.aborted]).toEqual([false, true, true, true]);
});
