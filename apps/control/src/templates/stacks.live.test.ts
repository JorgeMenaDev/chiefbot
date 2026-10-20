import { expect, test } from "bun:test";
import { TaskWorkerId } from "@chiefbot/contracts";
import { startFakeGitHub } from "@chiefbot/fake-github";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { z } from "zod";
import { installationToken } from "../github.ts";
import { loadTemplates, repoTemplates } from "./catalog.ts";
import { dockerStacks, type StackReport } from "./stacks.ts";

// Opt-in: two engineers' stacks of java-react-enterprise side by side on real
// Docker (Colima), as the template's two-copy check (check.sh) runs two copies.
// Each joins the network namespace of its own stand-in computer, a pause
// container, so both bind the same ports. The first run builds the stand-ins'
// images (minutes). Every name starts acme-stacktest-<run>-, and the test removes
// what it made: containers by ID, image tags by those names. Run with CHIEFBOT_DOCKER_TESTS=1 bun test stacks.live
const socketPath = process.env.CHIEFBOT_DOCKER_SOCKET ?? join(homedir(), ".colima/default/docker.sock");

// Runs the docker CLI on that socket: its exit code and its output, trimmed.
async function docker(...args: string[]) {
  const proc = Bun.spawn(["docker", "-H", `unix://${socketPath}`, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out: out.trim(), err: err.trim() };
}

const Records = z.array(z.object({ name: z.string() }));

test.skipIf(!process.env.CHIEFBOT_DOCKER_TESTS)(
  "two engineers' stacks run side by side, each in its computer's namespace with its own seeded data; the second reuses the first's image of a repo, and stop leaves nothing",
  async () => {
    const prefix = `acme-stacktest-${crypto.randomUUID().slice(0, 8)}-`;
    const github = startFakeGitHub();
    // auth's stand-in folder, as a repo of its own.
    const authDir = join(repoTemplates, "java-react-enterprise", "auth");
    const files = readdirSync(authDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    github.createRepo("octo-org/acme-auth", Object.fromEntries(files.map(({ parentPath, name }) => [relative(authDir, join(parentPath, name)), readFileSync(join(parentPath, name), "utf8")])));
    const template = loadTemplates(repoTemplates).find(({ name }) => name === "java-react-enterprise");
    if (!template) throw new Error("no java-react-enterprise template");
    // A read token for the repo, as control mints one (repos.ts readToken).
    const token = await installationToken(github.url, github.app, "octo-org/acme-auth", "read");
    const plan = { template, own: "ui", repos: { auth: { repo: "octo-org/acme-auth", ref: "main", token } }, secrets: [], network: { imagePrefix: null, proxy: {}, ca: null } };
    const stacks = dockerStacks({ socketPath, githubUrl: github.url, templatesDir: repoTemplates, prefix });
    const [first, second] = [TaskWorkerId.parse("worker_a"), TaskWorkerId.parse("worker_b")];
    const computers: string[] = [];
    try {
      for (const id of [first, second]) {
        const made = await docker("run", "-d", "--name", `${prefix}${id}`, "registry.k8s.io/pause:3.10");
        expect(made.code).toBe(0);
        computers.push(made.out);
      }
      const stages = new Map<TaskWorkerId, StackReport[]>([[first, []], [second, []]]);
      const report = (id: TaskWorkerId) => (stage: StackReport) => stages.get(id)?.push(stage);

      // The first builds auth from its repo; the second starts once that image is built, and reuses it.
      let built = () => {};
      const imageBuilt = new Promise<void>((resolve) => (built = resolve));
      const firstReady = stacks.start(first, plan, (stage) => {
        report(first)(stage);
        if (stage.label === "Build" && stage.state !== "running") built();
      });
      await imageBuilt;
      const secondReady = stacks.start(second, plan, report(second));

      const ready = await Promise.all([firstReady, secondReady]);
      for (const [id, reports] of stages) for (const { label, state, log } of reports) if (state === "failed") console.error(`${id} ${label} failed:\n${log}`);
      expect(ready).toEqual(["ready", "ready"]);
      for (const id of [first, second]) {
        expect(stages.get(id)?.map(({ label, state }) => `${label} ${state}`)).toEqual(
          ["Build", "Database", "API", "Gateway", "Seed"].flatMap((label) => [`${label} running`, `${label} passed`]),
        );
      }
      expect(stages.get(second)?.[1]?.log).toContain("auth: reusing");

      // Each stack is in its own computer's namespace, with no port of its own.
      const auth = (id: TaskWorkerId) => `${prefix}${id}-stack-auth-1`;
      for (const [at, id] of [first, second].entries()) {
        expect((await docker("inspect", "-f", "{{.HostConfig.NetworkMode}}", auth(id))).out).toBe(`container:${computers[at]}`);
      }
      // In each, the gateway on localhost:8081 answers alice with her seeded records, and a record made in one stays in it.
      const gateway = (id: TaskWorkerId, ...curl: string[]) =>
        docker("exec", auth(id), "curl", "-fsS", "-u", "alice:alice-password", "-H", "content-type: application/json", ...curl);
      const live = async (id: TaskWorkerId) => Records.parse(JSON.parse((await gateway(id, "http://localhost:8081/acme-meta/v1/records?schema=live")).out)).map(({ name }) => name);
      expect(await live(first)).toEqual(["live-alpha", "live-bravo", "live-charlie"]);
      expect((await gateway(first, "-X", "POST", "-d", '{"name":"made-in-a"}', "http://localhost:8081/acme-meta/v1/records")).code).toBe(0);
      expect(await live(first)).toContain("made-in-a");
      expect(await live(second)).toEqual(["live-alpha", "live-bravo", "live-charlie"]);
    } finally {
      await Promise.all([stacks.stop(first), stacks.stop(second)]);
      github.stop();
      for (const id of computers) await docker("rm", "-f", id);
      for (const kind of ["ps -a", "volume ls", "network ls"]) {
        expect((await docker(...kind.split(" "), "-q", "--filter", `label=com.docker.compose.project=${prefix}${first}-stack`)).out).toBe("");
        expect((await docker(...kind.split(" "), "-q", "--filter", `label=com.docker.compose.project=${prefix}${second}-stack`)).out).toBe("");
      }
      // The tags this run made, each removed by its own name, which only this run
      // uses: an image goes with its last tag, and one that had other tags before
      // (a cached build can match an image someone else built) keeps them. No -f, and the build cache stays.
      const ours = (await docker("image", "ls", "--format", "{{.Repository}}:{{.Tag}}")).out.split("\n").filter((tag) => tag.startsWith(prefix));
      for (const tag of ours) expect((await docker("rmi", "--no-prune", tag)).code).toBe(0);
    }
  },
  20 * 60_000,
);
