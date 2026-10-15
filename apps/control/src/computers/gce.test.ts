import { expect, test } from "bun:test";
import { BotId } from "@chiefbot/contracts";
import { fakeCompute } from "./fakeCompute.ts";
import { gceProvider } from "./gce.ts";

const template = "projects/chiefbot-poc/global/instanceTemplates/chiefbot-computer";
const image = "europe-west2-docker.pkg.dev/chiefbot-poc/chiefbot/computer:v1";

function setup() {
  const compute = fakeCompute();
  const computers = gceProvider({
    client: compute.client,
    project: "chiefbot-poc",
    zone: "europe-west2-a",
    instanceTemplate: template,
    image,
  });
  return { compute, computers };
}

// Shaped like control's ids: bot_<uuid>.
const botId = BotId.parse("bot_3f2b6c1e-9a4d-4e8f-b2a1-0c9d8e7f6a5b");
const vmName = "chiefbot-bot-3f2b6c1e-9a4d-4e8f-b2a1-0c9d8e7f6a5b";
const diskName = `${vmName}-home`;
const spec = { botId, env: { CHIEFBOT_BOT_TOKEN: "bot-secret" } };

test("create boots a VM from the template with the bot's own home disk, kept when the VM goes", async () => {
  const { compute, computers } = setup();

  await computers.create(spec);

  expect(await computers.status(botId)).toBe("running");
  expect([...compute.disks.keys()]).toEqual([diskName]);
  expect(compute.disks.get(diskName)).toMatchObject({ sizeGb: "50", type: "zones/europe-west2-a/diskTypes/pd-balanced" });
  const vm = compute.instances.get(vmName);
  expect(vm?.template).toBe(template);
  expect(vm?.request.disks).toContainEqual(
    expect.objectContaining({
      source: `projects/chiefbot-poc/zones/europe-west2-a/disks/${diskName}`,
      deviceName: "home",
      autoDelete: false,
    }),
  );
});

test("stop stops the VM and start boots it again; repeating either is harmless", async () => {
  const { computers } = setup();
  await computers.create(spec);

  await computers.stop(botId);
  await computers.stop(botId);
  expect(await computers.status(botId)).toBe("stopped");

  await computers.start(botId);
  await computers.start(botId);
  expect(await computers.status(botId)).toBe("running");
});

test("destroy removes the VM and keeps its home disk unless asked to delete the data", async () => {
  const { compute, computers } = setup();
  await computers.create(spec);

  await computers.destroy(botId, { deleteData: false });
  expect(await computers.status(botId)).toBe("absent");
  expect(compute.disks.has(diskName)).toBe(true);

  await computers.destroy(botId, { deleteData: true });
  await computers.destroy(botId, { deleteData: true });
  expect(compute.disks.size).toBe(0);
});

test("a replacement VM gets the bot's existing home disk back", async () => {
  const { compute, computers } = setup();
  await computers.create(spec);
  await computers.destroy(botId, { deleteData: false });

  await computers.create(spec);

  expect(await computers.status(botId)).toBe("running");
  expect([...compute.disks.keys()]).toEqual([diskName]);
});

test("the VM runs the bot computer image on Container-Optimized OS, with control's env and its disk as /home/bot", async () => {
  const { compute, computers } = setup();

  await computers.create(spec);

  const vm = compute.instances.get(vmName)?.request;
  expect(vm?.disks).toContainEqual(
    expect.objectContaining({
      boot: true,
      autoDelete: true,
      initializeParams: expect.objectContaining({ sourceImage: "projects/cos-cloud/global/images/family/cos-stable" }),
    }),
  );
  const userData = vm?.metadata?.items?.find((item) => item.key === "user-data")?.value ?? "";
  expect(userData).toStartWith("#cloud-config");
  expect(userData).toContain(`docker run`);
  expect(userData).toContain(image);
  expect(userData).toContain("CHIEFBOT_BOT_TOKEN=bot-secret");
  expect(userData).toContain("/dev/disk/by-id/google-home");
  expect(userData).toContain(":/home/bot");
});

test("the bot container runs as bot with no capabilities and cannot reach the VM's metadata server", async () => {
  const { compute, computers } = setup();

  await computers.create(spec);

  const userData = compute.instances.get(vmName)?.request.metadata?.items?.[0]?.value ?? "";
  const run = userData.split("\n").find((line) => line.includes("ExecStart=/usr/bin/docker run")) ?? "";
  expect(run).toContain("--user=bot");
  expect(run).toContain("--cap-drop=ALL");
  expect(run).toContain("--security-opt=no-new-privileges");
  expect(run).not.toContain("--network=host");
  expect(userData).toContain("DOCKER-USER -d 169.254.169.254 -j DROP");
});
