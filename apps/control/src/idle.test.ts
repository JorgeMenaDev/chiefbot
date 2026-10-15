import { afterEach, expect, test } from "bun:test";
import { fakeCopilot, sdk } from "@chiefbot/worker/fake-copilot";
import { tmpdir } from "node:os";
import { fakeClock } from "./clock.ts";
import { cleanUp, eventually, startTestControl } from "./testControl.ts";

afterEach(cleanUp);

const minute = 60_000;

// Control on a fake clock that stops idle bots after 30 minutes, with bot
// computers whose workers run a fake Copilot.
async function setup() {
  const time = fakeClock(Date.parse("2026-10-15T07:00:00Z"));
  const control = await startTestControl({
    clock: time.clock,
    idleStopMinutes: 30,
    copilot: fakeCopilot({ shell: { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } } }),
  });
  return { time, ...control, ...control.user };
}

test("a bot with nothing to do is stopped after the idle limit, and not before", async () => {
  const { time, computers, statusOf, onlineBot } = await setup();
  const ada = await onlineBot("Ada");

  time.advance(29 * minute);
  await Bun.sleep(50);
  expect(await statusOf(ada.id)).toBe("online");

  time.advance(2 * minute);
  await eventually(async () => (await statusOf(ada.id)) === "stopped");
  expect(await computers.provider.status(ada.id)).toBe("stopped");
});

test("a turn waiting on an approval and a screen viewer keep their bots running; once both end, the bots stop", async () => {
  const { time, computers, url, auth, api, statusOf, onlineBot, chat } = await setup();
  computers.copilot.script = async function* (_prompt, runtime) {
    await runtime.shell("git push origin main");
    yield sdk.idle();
  };
  const ada = await onlineBot("Ada");
  const grace = await onlineBot("Grace");
  await api("POST", `/bots/${ada.id}/messages`, { text: "push it" });
  await eventually(async () => (await chat(ada.id)).some((event) => event.type === "approval-request"));
  const viewer = new WebSocket(`${url.replace("http", "ws")}/bots/${grace.id}/screen`, { headers: auth });
  await new Promise((resolve) => (viewer.onmessage = resolve));

  time.advance(3 * 60 * minute);
  await Bun.sleep(50);
  expect([await statusOf(ada.id), await statusOf(grace.id)]).toEqual(["online", "online"]);

  const request = (await chat(ada.id)).find((event) => event.type === "approval-request");
  await api("POST", `/bots/${ada.id}/approvals/${request?.type === "approval-request" ? request.approvalId : ""}`, { approved: false });
  await eventually(async () => (await chat(ada.id)).at(-1)?.type === "done");
  viewer.close();
  await Bun.sleep(50);
  time.advance(29 * minute);
  await Bun.sleep(50);
  expect([await statusOf(ada.id), await statusOf(grace.id)]).toEqual(["online", "online"]);

  time.advance(2 * minute);
  await eventually(async () => (await statusOf(ada.id)) === "stopped" && (await statusOf(grace.id)) === "stopped");
});
