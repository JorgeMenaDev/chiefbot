import { SETUP_LOG_MAX, type StackStage, type TaskWorkerId, type Template, type TemplateStage } from "@chiefbot/contracts";
import { secretRedactor, type SecretRedactor } from "@chiefbot/worker/secret-redactor";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { rootCertificates } from "node:tls";
import { join, resolve } from "node:path";
import { z } from "zod";
import { dockerEngine } from "../computers/docker.ts";

// Each engineer's and verifier's own copy of its project's template stack
// (docs/templates.md). Control starts one after the worker's computer starts and
// before its setup (taskWorkers.ts), and removes it when the computer stops or
// goes. dockerStacks (below) runs them on the local Docker Engine; a fake in
// tests (fakeStacks.ts). The GCE provider has none.

// What a stack starts from:
//   template  the catalog's template
//   own       the project's own service: it runs in the computer, from the engineer's clone, never as a container
//   repos     the services that run from a repo, by name: its repo and ref (a branch or tag) and a
//             token that may read it (null: a public repo). Every other service runs its stand-in.
//   secrets   values no log of the stack may show: the project's secrets. The repos' tokens are hidden too.
//   network   behind a company network (docs/deploy.md): the prefix of base images, the proxy's
//             env (proxyEnv; empty with none) and the CA certificate's PEM text. Null when unset.
export type StackPlan = {
  template: Template;
  own: string;
  repos: Record<string, { repo: string; ref: string; token: string | null }>;
  secrets: string[];
  network: { imagePrefix: string | null; proxy: Record<string, string>; ca: string | null };
};

// A stage as a stack reports it; control adds the time.
export type StackReport = Omit<StackStage, "at">;

export type StackRunner = {
  // Starts the worker's stack in its computer's network namespace, reporting
  // each stage (stackStages) as it starts, passes or fails. Each log it reports
  // has the plan's secrets and tokens hidden, before it is cut to its end
  // (SETUP_LOG_MAX). Resolves once every stage passed ("ready"), or one failed
  // ("failed", its last report).
  start(id: TaskWorkerId, plan: StackPlan, onStage: (stage: StackReport) => void): Promise<"ready" | "failed">;
  // Removes the worker's stack, with its volumes and networks: first ending a
  // start still under way. Nothing to remove is fine.
  stop(id: TaskWorkerId): Promise<void>;
};

// The first stage of every stack: it clones the repos and builds the images.
// Its id is its own, so a template's stage may have its label too.
export const BUILD_STAGE = { id: "build", label: "Build" } as const;

// The template's stages a stack waits for, in order, each with its index in the
// template's stages as its id: not one that waits for the project's own
// service, which is the computer's setup, not the stack's. Such a stage waits
// for it alone (templateProblem refuses a template choice where not).
export function stackStages({ stages }: Template, own: string): Array<TemplateStage & { id: number }> {
  return stages.flatMap((stage, id) => (stage.waitsFor.includes(own) ? [] : [{ ...stage, id }]));
}

export type DockerStacksOptions = {
  // The Docker Engine's socket, the DockerProvider's.
  socketPath: string;
  // github.com, which repos are cloned from; the fake in tests.
  githubUrl: string;
  // The template catalog's folder: templates/<name>. A relative one is taken from
  // control's folder when the runner is made, since its commands run in each stack's own.
  templatesDir: string;
  // Starts every name a stack gets, and the name of its computer's container:
  // chiefbot-, as the DockerProvider names a computer chiefbot-<id>.
  prefix?: string;
};

// StackRunner on the local Docker Engine, with the docker CLI and its compose
// plugin. A worker's stack is the compose project <prefix><id>-stack, made from
// the template's compose file as `docker compose config` reads it:
// - the project's own service is left out, and so is any wait on it (nothing the
//   stack starts needs it: templateProblem) or on the seed (it runs once, in its stage);
// - every service joins the computer's network namespace (network_mode
//   container:<computer>), so it keeps its fixed port on the computer's
//   localhost. Docker refuses the keys that set a container's own network in
//   that mode (namespaceKeys), so they go: `ports` and `expose` among them.
// Build clones each repo a service runs from at its ref (resolved to a commit
// with git ls-remote) and builds its image, tagged by template, service, repo and
// commit: one that exists is reused. Stand-ins build from the template's folder
// each time, from Docker's build cache once built. Then each stage starts its
// services and waits until they are healthy (`up --wait`), and the seed until it
// has finished. Stop removes the project's containers, volumes and networks by
// its compose label, over the Engine API.
export function dockerStacks({ socketPath, githubUrl, templatesDir, prefix = "chiefbot-" }: DockerStacksOptions): StackRunner {
  const engine = dockerEngine(socketPath);
  const templates = resolve(templatesDir);
  const projectOf = (id: TaskWorkerId) => `${prefix}${id}-stack`.toLowerCase();
  // The docker CLI gets this environment alone, so none of control's own reaches
  // a template through compose's variables.
  const dockerEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}),
    DOCKER_HOST: `unix://${socketPath}`,
  };
  // Each start under way, so stop can end it first.
  const starts = new Map<TaskWorkerId, { abort: AbortController; done: Promise<"ready" | "failed"> }>();

  async function startStack(id: TaskWorkerId, { template, own, repos, secrets, network }: StackPlan, onStage: (stage: StackReport) => void, signal: AbortSignal): Promise<"ready" | "failed"> {
    const project = projectOf(id);
    const work = mkdtempSync(join(tmpdir(), "chiefbot-stack-"));
    const file = join(work, "compose.json");
    // Behind a company network: the CA for the builds' secret (stackModel), and
    // git's fetches of the repos go through the proxy, trusting the CA on top of the public roots.
    const caFile = join(work, "ca.pem");
    const cloneNetwork: Record<string, string> = { ...network.proxy };
    if (network.ca !== null) {
      writeFileSync(caFile, network.ca);
      writeFileSync(join(work, "ca-bundle.pem"), caBundle(network.ca));
      cloneNetwork.GIT_SSL_CAINFO = join(work, "ca-bundle.pem");
    }
    const hide = secretRedactor([...secrets, ...Object.values(repos).flatMap(({ token }) => (token === null ? [] : [token]))]);
    // The stage under way, as its reports name it.
    let current: Pick<StackReport, "id" | "label"> = BUILD_STAGE;
    let log = stageLog(hide);
    // Runs one step of the current stage (killed at `deadline`), its output into
    // the stage's log. A step that fails ends the stage. Each runs in the stack's
    // folder: compose builds with buildx bake, which reads a file such as the CA's
    // only inside the folder it runs in.
    const step = async (command: string[], deadline: AbortSignal, env: Record<string, string> = dockerEnv) => {
      const { exitCode, output } = await run(command, env, deadline, (text) => log.push(text), work);
      if (exitCode === 0) return output;
      if (deadline.aborted && !signal.aborted) log.push(`\nChiefbot stopped waiting after ${Math.round((current.id === BUILD_STAGE.id ? buildMs : stageMs) / 60_000)} minutes.\n`);
      throw new StepFailed();
    };
    const compose = (args: string[]) => ["docker", "compose", "-p", project, "-f", file, ...args];
    const services = (waitsFor: string[]) => waitsFor.filter((service) => service !== template.seed);
    try {
      onStage({ ...current, state: "running", log: "" });
      const build = AbortSignal.any([signal, AbortSignal.timeout(buildMs)]);
      const templateFile = join(templates, template.name, template.compose);
      await step(["docker", "compose", "-p", project, "-f", templateFile, "config", "--format", "json", "--output", file], build);
      const model = ComposeModel.parse(JSON.parse(readFileSync(file, "utf8")));
      const image = (service: string, version: string) => `${prefix}stack-${template.name}:${service}-${version}`;
      const images: Record<string, { image: string; context?: string }> = {};
      for (const [service, { build }] of Object.entries(model.services)) {
        if (service !== own && build && !repos[service]) images[service] = { image: image(service, "stand-in"), context: build.context };
      }
      for (const [service, { repo, ref, token }] of Object.entries(repos)) {
        const gitEnv = { ...gitEnvFor(token), ...cloneNetwork };
        const url = `${githubUrl}/${repo}.git`;
        const commit = resolveRef(await step(["git", "ls-remote", url, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`], build, gitEnv), ref);
        if (commit === null) {
          log.push(`${repo} has no branch or tag ${ref}.\n`);
          throw new StepFailed();
        }
        const tag = image(service, `${commit.slice(0, 12)}-${new Bun.CryptoHasher("sha256").update(repo.toLowerCase()).digest("hex").slice(0, 8)}`);
        if ((await run(["docker", "image", "inspect", tag], dockerEnv, build)).exitCode === 0) {
          log.push(`${service}: reusing ${tag}, built from ${repo} at ${commit}.\n`);
          images[service] = { image: tag };
          continue;
        }
        const clone = join(work, "repos", service);
        await step(["git", "init", "-q", clone], build, gitEnv);
        await step(["git", "-C", clone, "fetch", "-q", "--depth", "1", url, commit], build, gitEnv);
        await step(["git", "-C", clone, "checkout", "-q", "FETCH_HEAD"], build, gitEnv);
        images[service] = { image: tag, context: join(clone, template.services[service]?.context ?? ".") };
      }
      writeFileSync(file, JSON.stringify(stackModel(model, { computer: `${prefix}${id}`, own, seed: template.seed, images, network, caFile })));
      const toBuild = Object.entries(images).flatMap(([service, { context }]) => (context === undefined ? [] : [service]));
      if (toBuild.length > 0) await step(compose(["build", ...toBuild]), build);
      onStage({ ...current, state: "passed", log: log.end() });

      for (const stage of stackStages(template, own)) {
        current = { id: stage.id, label: stage.label };
        log = stageLog(hide);
        onStage({ ...current, state: "running", log: "" });
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(stageMs)]);
        try {
          const healthy = services(stage.waitsFor);
          if (healthy.length > 0) await step(compose(["up", "--detach", "--wait", "--no-build", ...healthy]), deadline);
          if (stage.waitsFor.includes(template.seed)) {
            await step(compose(["up", "--detach", "--no-build", template.seed]), deadline);
            await step(compose(["wait", template.seed]), deadline);
          }
        } finally {
          // What the stage's services said, passed or failed, unless the stack is being removed.
          if (!signal.aborted) {
            await run(compose(["logs", "--no-color", "--tail", "100", ...stage.waitsFor]), dockerEnv, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), (text) => log.push(text));
          }
        }
        onStage({ ...current, state: "passed", log: log.end() });
      }
      return "ready";
    } catch (error) {
      if (!(error instanceof StepFailed)) log.push(`${error instanceof Error ? error.message : String(error)}\n`);
      onStage({ ...current, state: "failed", log: log.end() });
      return "failed";
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  return {
    start(id, plan, onStage) {
      const abort = new AbortController();
      const done = startStack(id, plan, onStage, abort.signal);
      starts.set(id, { abort, done });
      return done.finally(() => starts.delete(id));
    },

    async stop(id) {
      const start = starts.get(id);
      start?.abort.abort();
      await start?.done;
      const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${projectOf(id)}`] }));
      const containers = Listed.parse(await (await engine("GET", `/containers/json?all=true&filters=${filters}`)).json());
      for (const { Id } of containers) await engine("DELETE", `/containers/${Id}?force=true&v=true`, undefined, [404]);
      const { Volumes } = VolumeList.parse(await (await engine("GET", `/volumes?filters=${filters}`)).json());
      for (const { Name } of Volumes ?? []) await engine("DELETE", `/volumes/${Name}`, undefined, [404]);
      const networks = Listed.parse(await (await engine("GET", `/networks?filters=${filters}`)).json());
      for (const { Id } of networks) await engine("DELETE", `/networks/${Id}`, undefined, [404]);
    },
  };
}

// How long Build may take (its first build of a JVM service downloads its world), and each other stage.
const buildMs = 30 * 60_000;
const stageMs = 10 * 60_000;

// A step of a stage failed: its output is in the stage's log.
class StepFailed extends Error {}

// What the Engine API lists: containers and networks, and volumes.
const Listed = z.array(z.object({ Id: z.string() }));
const VolumeList = z.object({ Volumes: z.array(z.object({ Name: z.string() })).nullable() });

// The parts of `docker compose config`'s model a stack changes. The rest passes through as it is.
const ComposeModel = z.looseObject({
  services: z.record(
    z.string(),
    z.looseObject({
      image: z.string().optional(),
      build: z
        .looseObject({
          context: z.string(),
          args: z.record(z.string(), z.string().nullable()).optional(),
          secrets: z.array(z.unknown()).optional(),
        })
        .optional(),
      // A map once `docker compose config` has read it; a list in a file as written.
      depends_on: z.union([z.array(z.string()), z.record(z.string(), z.unknown())]).optional(),
      environment: z.record(z.string(), z.string().nullable()).optional(),
      configs: z.array(z.unknown()).optional(),
    }),
  ),
  secrets: z.record(z.string(), z.unknown()).optional(),
  configs: z.record(z.string(), z.unknown()).optional(),
});
type ComposeModel = z.infer<typeof ComposeModel>;

// The keys Docker refuses on a container that joins another's network namespace.
const namespaceKeys = ["ports", "expose", "networks", "links", "hostname", "domainname", "dns", "dns_search", "dns_opt", "extra_hosts", "mac_address"];

// Where each service of a stack finds the company network's CA certificate
// (stackModel), and the env that points its tools there: Node adds the CA to its
// own roots; git, curl and OpenSSL read a bundle of the public roots and the CA.
const caFiles = { ca: "/etc/chiefbot/ca.pem", bundle: "/etc/chiefbot/ca-bundle.pem" };
const caEnv = { NODE_EXTRA_CA_CERTS: caFiles.ca, SSL_CERT_FILE: caFiles.bundle, CURL_CA_BUNDLE: caFiles.bundle, GIT_SSL_CAINFO: caFiles.bundle };

// The public roots Chiefbot trusts (Mozilla's, as Bun ships them), and the company's CA after them.
const caBundle = (ca: string) => [...rootCertificates, ca].join("\n");

// The stack's compose model (dockerStacks says what changes). `images` names the
// image of each service that has a build, and the folder it builds from when it
// must be built; one without a folder is reused, so it keeps no build.
// Behind a company network (`network`, docs/deploy.md), each build gets the
// proxy's env and CHIEFBOT_IMAGE_PREFIX as build args, and the CA as the build
// secret chiefbot-ca (`caFile`, which the runner writes) that a Dockerfile may
// mount. Each service gets the proxy's env and the CA, in its env and as files
// (caFiles: compose copies them into the container, so they need no path on the
// Docker host), and each image with no build the prefix. Unset, nothing. Exported for its test.
export function stackModel(
  { networks: _networks, services, ...model }: ComposeModel,
  {
    computer,
    own,
    seed,
    images,
    network,
    caFile,
  }: { computer: string; own: string; seed: string; images: Record<string, { image: string; context?: string }>; network: StackPlan["network"]; caFile: string },
) {
  const { imagePrefix, proxy, ca } = network;
  const env = { ...proxy, ...(ca === null ? {} : caEnv) };
  const args = { ...proxy, ...(imagePrefix === null ? {} : { CHIEFBOT_IMAGE_PREFIX: imagePrefix }) };
  const stack = Object.entries(services).flatMap(([name, { build, depends_on, ...service }]) => {
    if (name === own) return [];
    const kept = Object.fromEntries(Object.entries(service).filter(([key]) => !namespaceKeys.includes(key)));
    // A service no stage starts may still wait on the own service: compose refuses a wait on a service it lacks.
    const stays = (on: string) => on !== own && on !== seed;
    const waits = depends_on && (Array.isArray(depends_on) ? depends_on.filter(stays) : Object.fromEntries(Object.entries(depends_on).filter(([on]) => stays(on))));
    const image = images[name];
    const pulled = build === undefined && imagePrefix !== null && service.image !== undefined;
    return [
      [
        name,
        {
          ...kept,
          network_mode: `container:${computer}`,
          ...(waits ? { depends_on: waits } : {}),
          ...(image ? { image: image.image } : pulled ? { image: `${imagePrefix}${service.image}` } : {}),
          ...(Object.keys(env).length > 0 ? { environment: { ...service.environment, ...env } } : {}),
          ...(ca === null
            ? {}
            : {
                configs: [...(service.configs ?? []), { source: "chiefbot-ca", target: caFiles.ca }, { source: "chiefbot-ca-bundle", target: caFiles.bundle }],
              }),
          ...(build && image?.context !== undefined
            ? {
                build: {
                  ...build,
                  context: image.context,
                  ...(Object.keys(args).length > 0 ? { args: { ...build.args, ...args } } : {}),
                  ...(ca === null ? {} : { secrets: [...(build.secrets ?? []), { source: "chiefbot-ca" }] }),
                },
              }
            : {}),
        },
      ],
    ];
  });
  return {
    ...model,
    services: Object.fromEntries(stack),
    ...(ca === null
      ? {}
      : {
          secrets: { ...model.secrets, "chiefbot-ca": { file: caFile } },
          configs: { ...model.configs, "chiefbot-ca": { content: ca }, "chiefbot-ca-bundle": { content: caBundle(ca) } },
        }),
  };
}

// The commit `ref` names in git ls-remote's output: a branch first, as git clone
// --branch picks, then a tag's commit. Null when it names neither.
function resolveRef(listed: string, ref: string): string | null {
  const refs = new Map(listed.split("\n").flatMap((line) => {
    const [sha, name] = line.trim().split("\t");
    return sha && name ? [[name, sha] as const] : [];
  }));
  return refs.get(`refs/heads/${ref}`) ?? refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`) ?? null;
}

// Git's environment for a clone: no config of the machine's (so no credential
// helper of its own can lend its user's access) and no prompt; the token, if
// any, as an auth header in the environment, never in a URL or an argument.
function gitEnvFor(token: string | null): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...(token === null
      ? {}
      : { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${token}`)}` }),
  };
}

// A stage's log: what its steps print, each secret hidden as the text comes
// (one split across chunks too), and only then cut to its end. `end` gives the log.
function stageLog(hide: SecretRedactor) {
  const stream = hide.stream();
  let text = "";
  const keep = (more: string) => (text = (text + more).slice(-SETUP_LOG_MAX));
  return { push: (chunk: string) => void keep(stream.push(chunk)), end: () => keep(stream.end()) };
}

// Runs `command` with `env` alone (in `cwd`, if given), killed when `signal` aborts, its output
// (stdout and stderr together) to `out` as it comes: its exit code and the end
// of its output, for control to read, never to show.
async function run(command: string[], env: Record<string, string>, signal: AbortSignal, out: (text: string) => void = () => {}, cwd?: string) {
  const proc = Bun.spawn(["sh", "-c", 'exec "$@" 2>&1', "sh", ...command], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore", signal, ...(cwd === undefined ? {} : { cwd }) });
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of proc.stdout) {
    const text = decoder.decode(chunk, { stream: true });
    out(text);
    output = (output + text).slice(-SETUP_LOG_MAX);
  }
  const rest = decoder.decode();
  out(rest);
  return { exitCode: await proc.exited, output: output + rest };
}
