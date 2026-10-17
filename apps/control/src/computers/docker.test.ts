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
const spec = { id: botId, env: { CHIEFBOT_BOT_TOKEN: "bot-secret" } };

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

test("each bot is locked down: its own network, a non-root user, no capabilities and no Docker socket", async () => {
  const { engine, computers } = setup();
  const other = BotId.parse("bot_2");

  await computers.create(spec);
  await computers.create({ id: other, env: {} });

  expect([...engine.networks]).toEqual(["chiefbot-bot_1-net", "chiefbot-bot_2-net"]);
  expect(engine.containers.get("chiefbot-bot_1")?.config).toMatchObject({
    User: "bot",
    HostConfig: {
      NetworkMode: "chiefbot-bot_1-net",
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      // The bot's own volume is its only mount: no Docker socket, no host paths.
      Mounts: [{ Type: "volume", Source: "chiefbot-bot_1-home", Target: "/home/bot" }],
    },
  });
});

test("host.docker.internal names the Docker host on every engine, Linux included, so the worker reaches control there", async () => {
  const { engine, computers } = setup();

  await computers.create(spec);

  expect(engine.containers.get("chiefbot-bot_1")?.config).toMatchObject({ HostConfig: { ExtraHosts: ["host.docker.internal:host-gateway"] } });
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

test("destroy removes a running computer and its network, and keeps its volume unless asked to delete the data", async () => {
  const { engine, computers } = setup();
  await computers.create(spec);
  await computers.start(botId);

  await computers.destroy(botId, { deleteData: false });
  expect(await computers.status(botId)).toBe("absent");
  expect(engine.volumes.has("chiefbot-bot_1-home")).toBe(true);
  expect(engine.networks.size).toBe(0);

  await computers.destroy(botId, { deleteData: true });
  expect(engine.volumes.size).toBe(0);
});
