import { expect, test } from "bun:test";
import { computersConfig } from "./config.ts";

const home = "/Users/ada";

test("bots run on local Docker unless configured otherwise", () => {
  expect(computersConfig({}, home)).toEqual({
    provider: "docker",
    socketPath: "/Users/ada/.colima/default/docker.sock",
    image: "chiefbot-computer:dev",
  });
  expect(computersConfig({ DOCKER_HOST: "unix:///var/run/docker.sock" }, home)).toMatchObject({
    socketPath: "/var/run/docker.sock",
  });
});

test("CHIEFBOT_COMPUTERS=gce runs bots on Compute Engine, in London unless a zone is given", () => {
  const env = {
    CHIEFBOT_COMPUTERS: "gce",
    CHIEFBOT_GCP_PROJECT: "chiefbot-poc",
    CHIEFBOT_COMPUTER_IMAGE: "europe-west2-docker.pkg.dev/chiefbot-poc/chiefbot/computer:v1",
  };

  expect(computersConfig(env, home)).toEqual({
    provider: "gce",
    project: "chiefbot-poc",
    zone: "europe-west2-a",
    instanceTemplate: "projects/chiefbot-poc/global/instanceTemplates/chiefbot-computer",
    image: "europe-west2-docker.pkg.dev/chiefbot-poc/chiefbot/computer:v1",
  });
  expect(computersConfig({ ...env, CHIEFBOT_GCP_ZONE: "europe-west1-b" }, home)).toMatchObject({ zone: "europe-west1-b" });
});

test("gce without a project or an image fails, naming what is missing", () => {
  const gce = () => computersConfig({ CHIEFBOT_COMPUTERS: "gce" }, home);
  expect(gce).toThrow(/CHIEFBOT_GCP_PROJECT/);
  expect(gce).toThrow(/CHIEFBOT_COMPUTER_IMAGE/);
  expect(() => computersConfig({ CHIEFBOT_COMPUTERS: "k8s" }, home)).toThrow(/CHIEFBOT_COMPUTERS/);
});
