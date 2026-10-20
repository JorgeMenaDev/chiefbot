import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, ModelOption, Project, Workspace, type ChatEvent } from "@chiefbot/contracts";
import { defaultFakeUser } from "@chiefbot/fake-github";
import { fakeCopilot, fakeRequest, sdk, type FakeScript } from "@chiefbot/worker/fake-copilot";
import { atCleanUp, cleanUp, doneCount, eventually, fakeCoordinator, startTestControl, type TestControlOptions } from "./testControl.ts";

// The project agent reads its repo: control lets a coordinator turn's key fetch
// its own project's repo, and the coordinator keeps a copy of the default branch
// that its read and search tools stay inside. Real git through control's git
// proxy to the fake GitHub, the real coordinator on the fake Copilot.

afterEach(cleanUp);

// Control with a workspace and its project for octo-org/shop, which holds `files`.
async function projectOf(files: Record<string, string>, options: TestControlOptions = {}) {
  const control = await startTestControl(options);
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  control.github.createRepo("octo-org/shop", files);
  const project = Project.parse(await (await owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo: "octo-org/shop" })).json());
  return { ...control, owner, workspace, project };
}

// Git with no user or system config, run in a new temporary folder.
function gitIn() {
  const cwd = mkdtempSync(join(tmpdir(), "chiefbot-git-"));
  atCleanUp(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  // Async: control answers git in this same process.
  return async (...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { exitCode, stderr };
  };
}

test("a coordinator turn's key fetches its own project's repo through control, and nothing else: no other repo, no push", async () => {
  const control = await projectOf({ "README.md": "# Shop\n" });
  const { url, owner, project, github } = control;
  github.createRepo("octo-org/api", { "README.md": "# API\n" });
  const coordinator = await fakeCoordinator(control, project.id);
  coordinator.hello(null);
  await owner.api("POST", `/projects/${project.id}/messages`, { text: "what is in the repo?" });
  const { turnKey } = await coordinator.nth("run-turn");
  const git = gitIn();
  const asTurn = ["-c", `http.extraHeader=Authorization: Basic ${btoa(`x-access-token:${turnKey}`)}`];

  const own = await git(...asTurn, "clone", "-q", `${url}/git/octo-org/shop.git`, "shop");
  const other = await git(...asTurn, "clone", "-q", `${url}/git/octo-org/api.git`, "api");
  await git("-C", "shop", "-c", "user.name=x", "-c", "user.email=x@example.com", "commit", "-q", "--allow-empty", "-m", "Sneaky");
  const push = await git(...asTurn, "-C", "shop", "push", "-q", "origin", "HEAD:refs/heads/sneaky");

  expect(own.exitCode).toBe(0);
  expect([other.exitCode, other.stderr]).toEqual([128, expect.stringContaining("may only fetch octo-org/shop")]);
  expect([push.exitCode, push.stderr]).toEqual([128, expect.stringContaining("may only fetch octo-org/shop")]);
  expect(github.pushes).toEqual([]);
});

const shop = {
  "README.md": "# Shop\n",
  "src/checkout/Cart.tsx": 'import { CheckoutButton } from "./CheckoutButton";\n\nexport const Cart = () => <CheckoutButton />;\n',
  "src/checkout/CheckoutButton.tsx": "export function CheckoutButton() {\n  return <button>Check out</button>;\n}\n",
};

// Like a model answering from the repo: each tool call of `calls` in turn, its
// answer (or refusal) as the reply's next paragraph.
const answering =
  (...calls: Array<[string, Record<string, string | number | boolean>]>): FakeScript =>
  async function* (_prompt, runtime) {
    const answers: string[] = [];
    for (const [tool, args] of calls) {
      answers.push(await runtime.tool(tool, args).then(({ result }) => String(result), (error: Error) => `refused: ${error.message}`));
    }
    yield sdk.message("msg-1", answers.join("\n\n"));
    yield sdk.idle();
  };

// The text of the chat's replies, one per message.
const replies = (events: ChatEvent[]) => events.flatMap(({ event }) => (event.type === "text-delta" ? [event.text] : []));

// The owner asks the project `text` and waits for the reply; resolves with the chat's events so far.
async function ask(control: Awaited<ReturnType<typeof projectOf>>, text: string, turns = 1) {
  const chat = control.owner.watchProjectChat(control.project.id);
  await control.owner.api("POST", `/projects/${control.project.id}/messages`, { text });
  return chat.until(doneCount(turns));
}

test("asked where something is rendered, the coordinator answers from its copy of the repo with file paths, and no worker starts", async () => {
  const copilot = fakeCopilot({
    script: answering(["repo_search", { pattern: "<CheckoutButton" }], ["repo_read", { path: "src/checkout/CheckoutButton.tsx" }]),
  });
  const control = await projectOf(shop, { copilot });

  const events = await ask(control, "Where is the checkout button rendered?");

  expect(replies(events).join("")).toBe(
    [
      "src/checkout/Cart.tsx:3:export const Cart = () => <CheckoutButton />;",
      "1: export function CheckoutButton() {\n2:   return <button>Check out</button>;\n3: }",
    ].join("\n\n"),
  );
  expect([...control.computers.computers.keys()]).toEqual([control.project.id]);
});

test("each turn reads the default branch as it is then: a push to it shows in the next turn", async () => {
  const copilot = fakeCopilot({ script: answering(["repo_read", { path: "README.md" }]) });
  const control = await projectOf(shop, { copilot });
  await ask(control, "What does the readme say?");

  control.github.commit("octo-org/shop", { "README.md": "# Shop, now with a cart\n" });
  const events = await ask(control, "And now?", 2);

  expect(replies(events)).toEqual(["1: # Shop", "1: # Shop, now with a cart"]);
});

test("a fetch that fails is shown in the chat, and the repo tools say why instead of reading an old copy", async () => {
  const copilot = fakeCopilot({ script: answering(["repo_read", { path: "README.md" }]) });
  const control = await projectOf(shop, { copilot });
  await ask(control, "What does the readme say?");

  control.github.setAccess("octo-org/shop", "octo-user", null);
  const events = await ask(control, "And now?", 2);

  const fetches = events.flatMap(({ event }) => (event.type === "tool-call" && event.toolCallId === "repo-copy" && event.status !== "running" ? [event] : []));
  expect(fetches.map(({ name, status }) => [name, status])).toEqual([
    ["Fetch octo-org/shop", "succeeded"],
    ["Fetch octo-org/shop", "failed"],
  ]);
  expect(replies(events)).toEqual(["1: # Shop", expect.stringMatching(/^refused: The repo copy could not be refreshed this turn: .*octo-org\/shop was not found, or your GitHub account cannot see it/)]);
});

test("the coordinator is told the repo's instructions and gets its skill folders, from the copy of the turn", async () => {
  const copilot = fakeCopilot();
  const control = await projectOf(
    {
      ...shop,
      "chiefbot.project.yaml": "instructions: [docs/team.md]\nskills: [.agents/skills, .missing/skills]\n",
      "AGENTS.md": "# Agents\nRun bun test.\n",
      ".github/copilot-instructions.md": "Use tabs.\n",
      "docs/team.md": "Ask Ada about payments.\n",
      ".agents/skills/release/SKILL.md": "---\nname: release\ndescription: Ships a release.\n---\nTag it.\n",
    },
    { copilot },
  );
  const commit = control.github.git("octo-org/shop", "rev-parse", "main");

  await ask(control, "How do you ship here?");

  const told = copilot.instructions.at(-1) ?? "";
  expect(told).toContain(`You can read the repo: a copy of its default branch at commit ${commit}`);
  expect(told).toContain(
    [
      "## AGENTS.md\n# Agents\nRun bun test.",
      "## .github/copilot-instructions.md\nUse tabs.",
      "## docs/team.md\nAsk Ada about payments.",
    ].join("\n\n"),
  );
  const [skills] = copilot.skillDirectories.slice(-1);
  expect(skills?.map((folder) => folder.split("/").slice(-3).join("/"))).toEqual(["repo/.agents/skills"]);
  expect(await Bun.file(`${skills?.[0]}/release/SKILL.md`).text()).toContain("Tag it.");
});

test("when the copy cannot be fetched, the coordinator is told why, and gets no skills", async () => {
  const copilot = fakeCopilot();
  const control = await projectOf({ ...shop, "chiefbot.project.yaml": "skills: [.agents/skills]\n", ".agents/skills/release/SKILL.md": "Tag it.\n" }, { copilot });
  control.github.setAccess("octo-org/shop", "octo-user", null);

  await ask(control, "How do you ship here?");

  expect(copilot.instructions.at(-1)).toMatch(/You cannot read the repo this turn: its copy could not be fetched \(.*octo-org\/shop was not found, or your GitHub account cannot see it/);
  expect(copilot.skillDirectories.at(-1)).toEqual([]);
});

test("the coordinator still cannot run a command or write a file, and the runtime may read only inside the copy", async () => {
  const asked: boolean[] = [];
  const copilot = fakeCopilot({
    script: async function* (_prompt, runtime) {
      for (const request of [
        fakeRequest.shell("cat README.md"),
        fakeRequest.readOnlyShell("ls"),
        fakeRequest.write("README.md"),
        fakeRequest.read(`${root}/.agents/skills/release/SKILL.md`),
        fakeRequest.read(`${root}/../secret.txt`),
        fakeRequest.read("/etc/hosts"),
      ]) {
        asked.push(await runtime.permission(request));
      }
      yield sdk.idle();
    },
  });
  const control = await projectOf({ ...shop, ".agents/skills/release/SKILL.md": "Tag it.\n" }, { copilot });
  const root = control.computers.computers.get(control.project.id)?.repoRoot ?? "";
  await Bun.write(`${root}/../secret.txt`, "another member's chat");

  await ask(control, "Run the tests and fix the readme");

  expect(asked).toEqual([false, false, false, true, false, false]);
});

test("any member picks the project's model and effort among their plan's models, and the coordinator's turns run on them", async () => {
  const sonnet = { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ["low", "medium", "high"] };
  const copilot = fakeCopilot({ models: { list: [sonnet, { id: "o9-preview", name: "o9 (Preview)", policy: { state: "disabled" } }], modelPriceCategories: [] } });
  const control = await projectOf(shop, { copilot, user: { ...defaultFakeUser, copilot: { plan: "individual", sku: "monthly_subscriber" } } });
  const { owner, project } = control;
  // A bot's worker reports the plan's models.
  await owner.onlineBot("Ada");
  await eventually(async () => ModelOption.array().parse(await (await owner.api("GET", "/models")).json()).length > 1);
  // What the project runs on after asking for `body`, or control's refusal.
  const pick = async (body: { model: string; effort?: string | null }) => {
    const res = await owner.api("PUT", `/projects/${project.id}/model`, body);
    if (!res.ok) return `${res.status} ${ApiError.parse(await res.json()).error}`;
    const { model, effort } = Project.parse(await res.json());
    return `${model} at ${effort ?? "default"}`;
  };
  await ask(control, "Plan the cart");

  const picks = [await pick({ model: "claude-sonnet-4.6", effort: "max" }), await pick({ model: "o9-preview" }), await pick({ model: "claude-sonnet-4.6", effort: "high" })];
  await ask(control, "Plan the checkout", 2);

  expect([project.model, project.effort]).toEqual(["auto", null]);
  expect(picks).toEqual(["400 effort_unavailable", "400 model_unavailable", "claude-sonnet-4.6 at high"]);
  expect(Project.parse(await (await owner.api("GET", `/projects/${project.id}`)).json())).toMatchObject({ model: "claude-sonnet-4.6", effort: "high" });
  expect(copilot.sends.map(({ prompt, model, effort }) => [prompt, model, effort])).toEqual([
    ["Plan the cart", "auto", null],
    ["Plan the checkout", "claude-sonnet-4.6", "high"],
  ]);
});
