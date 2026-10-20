import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computersConfig, proxyEnv, proxySecrets } from "./config.ts";

const home = "/Users/ada";
const noNetwork = { imagePrefix: null, proxy: { http: null, https: null, noProxy: null }, ca: null };
const pem = "-----BEGIN CERTIFICATE-----\nMIIBacmeCA\n-----END CERTIFICATE-----\n";

// The company network of docker computers configured with `env`.
function networkOf(env: Record<string, string>) {
  const config = computersConfig(env, home, () => false);
  if (config.provider !== "docker") throw new Error("not docker");
  return config.network;
}

test("bots run on local Docker unless configured otherwise", () => {
  const colima = "/Users/ada/.colima/default/docker.sock";
  expect(computersConfig({}, home, (path) => path === colima)).toEqual({
    provider: "docker",
    socketPath: colima,
    image: "chiefbot-computer:dev",
    network: noNetwork,
  });
  expect(computersConfig({ DOCKER_HOST: "unix:///run/user/501/docker.sock" }, home, () => true)).toMatchObject({
    socketPath: "/run/user/501/docker.sock",
  });
});

test("without Colima, control uses the standard Docker socket (Docker Desktop, OrbStack, Linux)", () => {
  expect(computersConfig({}, home, () => false)).toMatchObject({ socketPath: "/var/run/docker.sock" });
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

test("behind a company network, docker computers get the deployer's image prefix, proxy and CA certificate, read once at start; unset or empty, none", () => {
  const dir = mkdtempSync(join(tmpdir(), "acme-config-test-"));
  try {
    writeFileSync(join(dir, "company-ca.pem"), pem);
    const env = {
      CHIEFBOT_IMAGE_PREFIX: "registry.example.com/hub",
      HTTPS_PROXY: "http://proxy.example.com:3128",
      https_proxy: "http://ignored.example.com:1",
      http_proxy: "http://proxy.example.com:3128",
      no_proxy: ".corp.example.com,10.0.0.0/8",
      CHIEFBOT_CA_FILE: join(dir, "company-ca.pem"),
    };

    expect(networkOf(env)).toEqual({
      imagePrefix: "registry.example.com/hub/",
      proxy: { http: "http://proxy.example.com:3128", https: "http://proxy.example.com:3128", noProxy: ".corp.example.com,10.0.0.0/8" },
      ca: pem,
    });
    expect(networkOf({ ...env, CHIEFBOT_IMAGE_PREFIX: "registry.example.com/hub/" }).imagePrefix).toBe("registry.example.com/hub/");
    const empty = { CHIEFBOT_IMAGE_PREFIX: "", HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "", CHIEFBOT_CA_FILE: "" };
    expect(networkOf(empty)).toEqual(noNetwork);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a CA certificate file that is missing, unreadable or holds no PEM certificate stops control, naming CHIEFBOT_CA_FILE and the path", () => {
  const dir = mkdtempSync(join(tmpdir(), "acme-config-test-"));
  const config = (file: string) => () => networkOf({ CHIEFBOT_CA_FILE: file });
  try {
    const missing = join(dir, "missing.pem");
    expect(config(missing)).toThrow(`CHIEFBOT_CA_FILE: cannot read ${missing}`);
    mkdirSync(join(dir, "folder.pem"));
    expect(config(join(dir, "folder.pem"))).toThrow(`CHIEFBOT_CA_FILE: cannot read ${join(dir, "folder.pem")}`);
    writeFileSync(join(dir, "der.cer"), "0\x82\x01\x0a");
    expect(config(join(dir, "der.cer"))).toThrow(`CHIEFBOT_CA_FILE: ${join(dir, "der.cer")} holds no PEM certificate (-----BEGIN CERTIFICATE-----)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the proxy's env leaves the deployer's NO_PROXY, localhost and control's own host out of the proxy; with no proxy set it is empty", () => {
  const proxy = { http: null, https: "http://proxy.example.com:3128", noProxy: " .corp.example.com , localhost" };

  expect(proxyEnv({ ...noNetwork, proxy }, "https://chiefbot.example.com")).toEqual({
    HTTPS_PROXY: "http://proxy.example.com:3128",
    https_proxy: "http://proxy.example.com:3128",
    NO_PROXY: ".corp.example.com,localhost,127.0.0.1,::1,chiefbot.example.com",
    no_proxy: ".corp.example.com,localhost,127.0.0.1,::1,chiefbot.example.com",
  });
  // An IPv6 control host goes in without its URL's brackets, as curl and git read NO_PROXY.
  expect(proxyEnv({ ...noNetwork, proxy }, "http://[fd00::1234]:7410").NO_PROXY).toBe(".corp.example.com,localhost,127.0.0.1,::1,fd00::1234");
  expect(proxyEnv({ ...noNetwork, proxy: { ...proxy, https: null } }, "http://host.docker.internal:7410")).toEqual({});
});

test("a proxy's credentials are what no log may show: each proxy URL that has them, its user:password as written and decoded, and its password; a proxy without them has none", () => {
  const proxy = { http: "http://acme:p%40ss-word1@proxy.example.com:3128", https: "proxy.example.com:3128", noProxy: null };

  expect(proxySecrets({ ...noNetwork, proxy })).toEqual(["http://acme:p%40ss-word1@proxy.example.com:3128", "acme:p%40ss-word1", "acme:p@ss-word1", "p@ss-word1"]);
  // A proxy that takes a token as its user name, written without a scheme.
  expect(proxySecrets({ ...noNetwork, proxy: { ...proxy, http: null, https: "tok-0123456789@proxy.example.com:3128" } })).toEqual(["tok-0123456789@proxy.example.com:3128", "tok-0123456789"]);
  expect(proxySecrets(noNetwork)).toEqual([]);
});
