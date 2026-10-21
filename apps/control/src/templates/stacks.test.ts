import { expect, test } from "bun:test";
import { SETUP_LOG_MAX, TaskWorkerId } from "@chiefbot/contracts";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { loadTemplates, repoTemplates } from "./catalog.ts";
import { dockerStacks, stackModel, type StackReport } from "./stacks.ts";

test("a stage's log keeps the end of what its steps print, every secret hidden before the cut: one the cut lands inside too", async () => {
  const token = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";
  const password = "hunter2-dev";
  // A docker CLI that prints the token, whose start falls before the log's last
  // SETUP_LOG_MAX characters and whose last 20 inside them, then the project's
  // secret, then fails. No Docker is reached.
  const bin = mkdtempSync(join(tmpdir(), "acme-stacks-test-"));
  writeFileSync(join(bin, "printed"), `${"a".repeat(100)}${token}\n${password}\n${"b".repeat(SETUP_LOG_MAX - 33)}`);
  writeFileSync(join(bin, "docker"), `#!/bin/sh\ncat "${join(bin, "printed")}"\nexit 1\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const stacks = dockerStacks({ socketPath: join(bin, "no.sock"), githubUrl: "http://127.0.0.1:9", templatesDir: repoTemplates, prefix: "acme-stacktest-" });
  process.env.PATH = path;
  const template = loadTemplates(repoTemplates).find(({ name }) => name === "java-react-enterprise");
  if (!template) throw new Error("no java-react-enterprise template");
  const reports: StackReport[] = [];

  try {
    const outcome = await stacks.start(
      TaskWorkerId.parse("worker_a"),
      { template, own: "ui", repos: { auth: { repo: "octo-org/acme-auth", ref: "main", token } }, secrets: [password], network: { imagePrefix: null, proxy: {}, ca: null } },
      (stage) => reports.push(stage),
    );

    expect(outcome).toBe("failed");
    expect(reports.map(({ id, label, state }) => `${id} ${label} ${state}`)).toEqual(["build Build running", "build Build failed"]);
    expect(reports.at(-1)?.log).toBe(`${"a".repeat(25)}***\n***\n${"b".repeat(SETUP_LOG_MAX - 33)}`);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("behind a company network, control fetches a service's repo through the proxy, trusting the CA, and the build gets the CA as the chiefbot-ca secret's file", async () => {
  const ca = "-----BEGIN CERTIFICATE-----\nMIIBacmeCA\n-----END CERTIFICATE-----\n";
  const proxy = { HTTPS_PROXY: "http://proxy.example.com:3128", https_proxy: "http://proxy.example.com:3128", NO_PROXY: "localhost", no_proxy: "localhost" };
  // A docker CLI whose compose reads a one-service model and whose build keeps
  // what it was given (the stack's folder) and where it ran, and fails, and a git
  // that keeps its env and the CA bundle it was pointed at. No Docker or network is reached.
  const bin = mkdtempSync(join(tmpdir(), "acme-stacks-test-"));
  writeFileSync(join(bin, "model.json"), JSON.stringify({ name: "acme", services: { auth: { build: { context: "/t/auth" }, image: "acme-auth:local" } } }));
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
for arg in "$@"; do [ "$last" = --output ] && cp "${join(bin, "model.json")}" "$arg" && exit 0; [ "$last" = -f ] && file=$arg; last=$arg; done
case " $* " in *" build "*) cp -R "$(dirname "$file")" "${join(bin, "work")}"; pwd -P > "${join(bin, "build-cwd")}"; (cd "$(dirname "$file")" && pwd -P) > "${join(bin, "build-folder")}";; esac
exit 1
`,
  );
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
case "$1" in
  ls-remote) env > "${join(bin, "git-env")}"; cp "$GIT_SSL_CAINFO" "${join(bin, "git-ca")}"; printf '0123456789abcdef0123456789abcdef01234567\trefs/heads/main\n';;
  init) mkdir -p "$3";;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const template = loadTemplates(repoTemplates).find(({ name }) => name === "java-react-enterprise");
  if (!template) throw new Error("no java-react-enterprise template");
  const reports: StackReport[] = [];

  try {
    const stacks = dockerStacks({ socketPath: join(bin, "no.sock"), githubUrl: "http://127.0.0.1:9", templatesDir: repoTemplates, prefix: "acme-stacktest-" });
    const outcome = await stacks.start(
      TaskWorkerId.parse("worker_a"),
      { template, own: "ui", repos: { auth: { repo: "octo-org/acme-auth", ref: "main", token: null } }, secrets: [], network: { imagePrefix: null, proxy, ca } },
      (stage) => reports.push(stage),
    );

    expect(outcome).toBe("failed");
    expect(reports.map(({ label, state }) => `${label} ${state}`)).toEqual(["Build running", "Build failed"]);
    const gitEnv = readFileSync(join(bin, "git-env"), "utf8").split("\n");
    for (const [name, value] of Object.entries(proxy)) expect(gitEnv).toContain(`${name}=${value}`);
    expect(readFileSync(join(bin, "git-ca"), "utf8").endsWith(`\n${ca}`)).toBe(true);
    const built = z.object({ secrets: z.object({ "chiefbot-ca": z.object({ file: z.string() }) }) }).parse(JSON.parse(readFileSync(join(bin, "work", "compose.json"), "utf8")));
    expect(readFileSync(join(bin, "work", basename(built.secrets["chiefbot-ca"].file)), "utf8")).toBe(ca);
    // The build runs in the stack's folder, beside the CA: compose builds with buildx bake, which reads no file outside the folder it runs in.
    expect(readFileSync(join(bin, "build-cwd"), "utf8")).toBe(readFileSync(join(bin, "build-folder"), "utf8"));
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("a templates folder given as a relative path still works, though compose runs in the stack's own folder: the template's compose file is read by its absolute path", async () => {
  // A docker CLI that keeps the compose file it is asked to read, and whether it found it from where it runs, then fails.
  const bin = mkdtempSync(join(tmpdir(), "acme-stacks-test-"));
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
for arg in "$@"; do [ "$last" = -f ] && printf '%s %s' "$arg" "$([ -f "$arg" ] && echo found || echo missing)" > "${join(bin, "read")}" && exit 1; last=$arg; done
exit 1
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const template = loadTemplates(repoTemplates).find(({ name }) => name === "java-react-enterprise");
  if (!template) throw new Error("no java-react-enterprise template");

  try {
    const templatesDir = relative(process.cwd(), repoTemplates);
    expect(isAbsolute(templatesDir)).toBe(false);
    const stacks = dockerStacks({ socketPath: join(bin, "no.sock"), githubUrl: "http://127.0.0.1:9", templatesDir, prefix: "acme-stacktest-" });
    const plan = { template, own: "ui", repos: {}, secrets: [], network: { imagePrefix: null, proxy: {}, ca: null } };

    expect(await stacks.start(TaskWorkerId.parse("worker_a"), plan, () => {})).toBe("failed");
    expect(readFileSync(join(bin, "read"), "utf8")).toBe(`${join(repoTemplates, "java-react-enterprise", "compose.yaml")} found`);
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("the stack's compose model leaves out the project's own service, and every wait on it or on the seed, in services nothing starts too and in either form of depends_on", () => {
  const healthy = { condition: "service_healthy" };
  const model = stackModel(
    {
      name: "acme",
      networks: { default: {} },
      services: {
        ui: { build: { context: "/t/ui" }, network_mode: "service:pod", depends_on: { seed: { condition: "service_completed_successfully" } } },
        seed: { image: "acme-seed:local", depends_on: { auth: healthy } },
        auth: { image: "acme-auth:local", expose: ["8081"] },
        // In no stage: nothing starts it, and it needs the project's own service.
        diagnostic: { image: "acme-diagnostic:local", depends_on: { ui: { condition: "service_started" }, auth: healthy } },
        probe: { image: "acme-probe:local", depends_on: ["ui", "seed", "auth"] },
      },
    },
    { computer: "chiefbot-worker_a", own: "ui", seed: "seed", images: {}, network: { imagePrefix: null, proxy: {}, ca: null }, caFile: "/tmp/stack/ca.pem" },
  );

  const joined = { network_mode: "container:chiefbot-worker_a" };
  expect(model.services).toEqual({
    seed: { image: "acme-seed:local", ...joined, depends_on: { auth: healthy } },
    auth: { image: "acme-auth:local", ...joined },
    diagnostic: { image: "acme-diagnostic:local", ...joined, depends_on: { auth: healthy } },
    probe: { image: "acme-probe:local", ...joined, depends_on: ["auth"] },
  });
  // The project's other keys stay, but its networks: every service is in the computer's.
  expect(model).toHaveProperty("name", "acme");
  expect(model).not.toHaveProperty("networks");
  // No company network: no secret or config of Chiefbot's.
  expect(model).not.toHaveProperty("secrets");
  expect(model).not.toHaveProperty("configs");
});

test("behind a company network, the stack's builds get the proxy and the image prefix as build args and the CA as the build secret chiefbot-ca; every service gets the proxy and the CA, and an image with no build the prefix", () => {
  const ca = "-----BEGIN CERTIFICATE-----\nMIIBacmeCA\n-----END CERTIFICATE-----\n";
  const proxy = { HTTPS_PROXY: "http://proxy.example.com:3128", https_proxy: "http://proxy.example.com:3128", NO_PROXY: "localhost", no_proxy: "localhost" };
  const model = stackModel(
    {
      name: "acme",
      services: {
        ui: { build: { context: "/t/ui" } },
        postgres: { image: "postgres:17", environment: { POSTGRES_DB: "acme" } },
        meta: { build: { context: "/t/meta", args: { GRADLE_FLAGS: "--quiet" }, secrets: [{ source: "acme-token" }] }, image: "acme-meta:local" },
        auth: { build: { context: "/t/auth" }, image: "acme-auth:local", environment: { HTTPS_PROXY: "http://template.example.com:1" } },
      },
      secrets: { "acme-token": { file: "/t/token" } },
    },
    {
      computer: "chiefbot-worker_a",
      own: "ui",
      seed: "seed",
      // meta builds its stand-in; auth reuses an image built from its repo.
      images: { meta: { image: "chiefbot-stack-acme:meta-stand-in", context: "/t/meta" }, auth: { image: "chiefbot-stack-acme:auth-0123456789ab-cafe1234" } },
      network: { imagePrefix: "registry.example.com/hub/", proxy, ca },
      caFile: "/tmp/stack/ca.pem",
    },
  );

  const joined = { network_mode: "container:chiefbot-worker_a" };
  const trusted = {
    ...proxy,
    NODE_EXTRA_CA_CERTS: "/etc/chiefbot/ca.pem",
    SSL_CERT_FILE: "/etc/chiefbot/ca-bundle.pem",
    CURL_CA_BUNDLE: "/etc/chiefbot/ca-bundle.pem",
    GIT_SSL_CAINFO: "/etc/chiefbot/ca-bundle.pem",
  };
  const configs = [
    { source: "chiefbot-ca", target: "/etc/chiefbot/ca.pem" },
    { source: "chiefbot-ca-bundle", target: "/etc/chiefbot/ca-bundle.pem" },
  ];
  expect(model.services).toEqual({
    postgres: { image: "registry.example.com/hub/postgres:17", ...joined, environment: { POSTGRES_DB: "acme", ...trusted }, configs },
    meta: {
      image: "chiefbot-stack-acme:meta-stand-in",
      ...joined,
      environment: trusted,
      configs,
      build: {
        context: "/t/meta",
        args: { GRADLE_FLAGS: "--quiet", ...proxy, CHIEFBOT_IMAGE_PREFIX: "registry.example.com/hub/" },
        secrets: [{ source: "acme-token" }, { source: "chiefbot-ca" }],
      },
    },
    auth: { image: "chiefbot-stack-acme:auth-0123456789ab-cafe1234", ...joined, environment: trusted, configs },
  });
  expect(model.secrets).toEqual({ "acme-token": { file: "/t/token" }, "chiefbot-ca": { file: "/tmp/stack/ca.pem" } });
  // The bundle is the public roots Chiefbot trusts, and the company's CA after them.
  expect(model.configs?.["chiefbot-ca"]).toEqual({ content: ca });
  const { content: bundle } = z.object({ content: z.string() }).parse(model.configs?.["chiefbot-ca-bundle"]);
  expect(bundle.split("-----BEGIN CERTIFICATE-----").length - 1).toBeGreaterThan(100);
  expect(bundle.endsWith(`\n${ca}`)).toBe(true);
});
