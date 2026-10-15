import { afterEach, expect, test } from "bun:test";
import { BotId } from "@chiefbot/contracts";
import { dockerProvider } from "./docker.ts";
import { startFakeDockerEngine } from "./fakeDockerEngine.ts";

const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function setup() {
  const engine = startFakeDockerEngine();
  stops.push(engine.stop);
  const computers = dockerProvider({ socketPath: engine.socketPath, image: "chiefbot-computer:test" });
  return { engine, computers };
}

const botId = BotId.parse("bot_1");
const spec = { botId, env: { CHIEFBOT_BOT_TOKEN: "bot-secret" } };

test("create makes a stopped container from the image, with the env and the bot's own volume as home", async () => {
  const { engine, computers } = setup();

  await computers.create(spec);

  expect(await computers.status(botId)).toBe("stopped");
  expect([...engine.volumes]).toEqual(["chiefbot-bot_1-home"]);
  expect(engine.containers.get("chiefbot-bot_1")?.config).toMatchObject({
    Image: "chiefbot-computer:test",
    Env: ["CHIEFBOT_BOT_TOKEN=bot-secret"],
    HostConfig: { Mounts: [{ Type: "volume", Source: "chiefbot-bot_1-home", Target: "/home/bot" }] },
  });
});

test("start runs the computer and stop stops it; repeating either is harmless", async () => {
  const { computers } = setup();
  await computers.create(spec);

  await computers.start(botId);
  await computers.start(botId);
  expect(await computers.status(botId)).toBe("running");

  await computers.stop(botId);
  await computers.stop(botId);
  expect(await computers.status(botId)).toBe("stopped");
});

test("destroy removes a running computer and keeps its volume unless asked to delete the data", async () => {
  const { engine, computers } = setup();
  await computers.create(spec);
  await computers.start(botId);

  await computers.destroy(botId, { deleteData: false });
  expect(await computers.status(botId)).toBe("absent");
  expect(engine.volumes.has("chiefbot-bot_1-home")).toBe(true);

  await computers.destroy(botId, { deleteData: true });
  expect(engine.volumes.size).toBe(0);
});

test("the screen's websockify port is published on loopback only, and its URL exists while running", async () => {
  const { engine, computers } = setup();
  await computers.create(spec);

  expect(engine.containers.get("chiefbot-bot_1")?.config).toMatchObject({
    ExposedPorts: { "6080/tcp": {} },
    HostConfig: { PortBindings: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
  });
  expect(await computers.screenUrl(botId)).toBeNull();

  await computers.start(botId);
  expect(await computers.screenUrl(botId)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

  await computers.stop(botId);
  expect(await computers.screenUrl(botId)).toBeNull();
});
