import { afterEach, expect, test } from "bun:test";
import { ClientEvent, Project, Workspace, WorkspaceInvite, type ProjectId, type ProjectState } from "@chiefbot/contracts";
import type { FakeGitHubUser } from "@chiefbot/fake-github";
import { atCleanUp, cleanUp, eventually, fakeCoordinator, startTestControl, type TestControl, type TestUser } from "./testControl.ts";

// What the desktop's Projects tab reads from control: each project's state dot.

afterEach(cleanUp);

const friend: FakeGitHubUser = { id: 5151, login: "octo-friend", copilot: { plan: "individual", sku: "free_limited_copilot" } };

// Control with a workspace owned by the signed-in user, octo-friend as its
// member, and a project for octo-org/shop.
async function teamProject() {
  const control = await startTestControl();
  const owner = control.user;
  const workspace = Workspace.parse(await (await owner.api("POST", "/workspaces", { name: "Platform team" })).json());
  await owner.api("POST", `/workspaces/${workspace.id}/invites`, { login: friend.login });
  const guest = await control.signIn(friend);
  const [invite] = WorkspaceInvite.array().parse(await (await guest.api("GET", "/invites")).json());
  await guest.api("POST", `/invites/${invite?.id}/accept`);
  control.github.createRepo("octo-org/shop", { "README.md": "# Shop\n" }, { access: { "octo-user": "write", "octo-friend": "write" } });
  const project = Project.parse(await (await owner.api("POST", `/workspaces/${workspace.id}/projects`, { repo: "octo-org/shop" })).json());
  return { ...control, owner, guest, workspace, project };
}

// The project states a member's /events socket has said, latest per project.
function watchStates({ url }: TestControl, member: TestUser) {
  const socket = new WebSocket(`${url.replace("http", "ws")}/events`, { headers: member.auth });
  atCleanUp(() => socket.close());
  const states = new Map<ProjectId, ProjectState>();
  socket.onmessage = (event) => {
    const message = ClientEvent.parse(JSON.parse(String(event.data)));
    if (message.type === "project-state") states.set(message.projectId, message.state);
  };
  return { until: (projectId: ProjectId, state: ProjectState) => eventually(() => states.get(projectId) === state) };
}

test("each member sees a project's state: sleeping until its agent is ready, working on a message, needs you only for whom a task asks", async () => {
  const control = await teamProject();
  const { owner, guest, project } = control;
  const coordinator = await fakeCoordinator(control, project.id);
  const ownerStates = watchStates(control, owner);
  const guestStates = watchStates(control, guest);
  await ownerStates.until(project.id, "sleeping");

  coordinator.hello(null);
  await ownerStates.until(project.id, "idle");
  await guestStates.until(project.id, "idle");

  await owner.api("POST", `/projects/${project.id}/messages`, { text: "Which page has the typo?" });
  const { turnId, turnKey } = await coordinator.nth("run-turn");
  await guestStates.until(project.id, "working");
  const tool = (call: Record<string, unknown>) =>
    fetch(`${control.url}/coordinator/${project.id}/tools`, { method: "POST", headers: { authorization: `Bearer ${turnKey}` }, body: JSON.stringify(call) });
  await tool({ tool: "create_task", title: "Fix the typo" });
  await tool({ tool: "update_task", number: 1, status: "needs_input", question: "Which page?" });
  coordinator.event(turnId, { type: "done" });

  await ownerStates.until(project.id, "needs_you");
  await guestStates.until(project.id, "idle");
});
