# Templates

A **template** is a kind of service stack an engineer can get beside its code: for example a UI with its API, its gateway, a database and a seed step. Chiefbot ships a catalog of them in `templates/`, one folder each, as it ships connections in `connections/`. The first is `java-react-enterprise` (`templates/java-react-enterprise/README.md`).

Control loads and lists the catalog, a project picks a template (**Use one in a project**, below), and each of the project's engineers and verifiers gets its own copy of the stack (**An engineer's stack**).

## See them

Open the gear menu at the bottom left of the sidebar and click **Connect apps**. **Templates**, under your connections, lists each template:

- its title and folder name;
- what it runs;
- **From a repo**: the services a project may run from its own repos instead of the stand-ins;
- **Setup**: its stages in order, each with the compose services it waits for.

The list is read-only. A template changes only with the repo. Control serves the list at `GET /templates`.

## Use one in a project

A project picks a template with three keys, in its `chiefbot.project.yaml` or in its settings in the app (README, **Projects**):

```yaml
template: java-react-enterprise                  # a template of the catalog, by its folder's name
service: ui                                      # the template service this repo is
services:                                        # where each other service runs from
  meta: { repo: octo-org/meta-api, ref: main }   # a repo (owner/name) at a branch or tag
  auth: stand-in                                 # the template's own stand-in
```

- `service` is the service the project's own repo is. It never runs as a container: each engineer runs it from its own clone, through `commands.setup` and `commands.dev`, so its edits show live. `services` cannot name it.
- Each entry of `services` is `{ repo, ref }` or `stand-in`. A repo's image builds from the service's `context` in that repo, at `ref`, a branch or tag. `ref` follows git's ref-name rules (`git check-ref-format`) and cannot start with `-`. Both keys are required, and no other key is allowed. A service that `services` leaves out runs its stand-in.
- The settings override the file key by key, as for the other keys. `template`, `service` and `services` are each taken whole, so the settings' `services` replaces the file's. Settings without `template` take the file's. `template: null` in the settings turns templates off, and the file's `service` and `services` with them.

Control checks the keys against the catalog when it reads the file, as the project is made, when settings are saved, and when a stack starts (**An engineer's stack**). It refuses:

- a template that is not in the catalog;
- a service the template does not have, in `service` or in `services`. Only the template's `services` count: a compose service such as `postgres` does not;
- `services` naming the project's own service, or pointing another service at the project's own repo;
- a `service` the rest of the stack needs, since the engineer runs it only once the rest is up. That is a service the stack starts (every stage's, the seed, and what they need in compose) that needs it through `depends_on` or `network_mode: service:<name>`, or a stage that waits for it with other services. The error names what needs it and the services nothing needs: `service: meta is needed by auth, so it cannot run from the engineer's code. Pick a service the rest of the stack does not need, such as ui.` In `java-react-enterprise`, only `ui` qualifies;
- a template without `service`, or `service` or `services` without a template;
- a repo the member cannot read, checked as for the project's own repo: through the repo app, or as a public repo where the app is not installed. A save checks the repos its settings name, as the member who saves.

A file that breaks one of these rules is invalid: the project uses its settings alone, and **Settings** shows the error. Settings that break one are not saved (`invalid_settings`), and the error names the key. If GitHub fails while control checks a repo (a 5xx, a lost connection), control makes no project and saves nothing, and answers `github_failed` (502): try again.

In the app, open the project's gear. **Template and services** has a picker with the catalog. Under it you pick the service this repo is, and for each other service **Stand-in** or **A repo**, with its repo and branch or tag. The project's own service is marked **This repo** and has no repo to pick. **None** writes `template: null`, and says **(overrides the project file)** when the file sets a template. **Save** writes the keys into the settings and keeps their other keys and comments, those on `services` and its entries included. **Config** then shows each key with its source. While the YAML under **Settings** has unsaved edits, the picker cannot save, because its save would drop them: save or undo them first.

## Add one

A template is a folder, `templates/<name>/`, with a `template.yaml`, a compose file and the stand-in services the compose file builds. Control reads every folder when it starts (`CHIEFBOT_TEMPLATES_DIR`, default the repo's `templates`). If one is wrong, control refuses to start and names the file and the problem. No code changes.

`template.yaml` holds only what Chiefbot needs that compose cannot say. An unknown key is an error, and each YAML file may hold up to 256 KB. `templates/java-react-enterprise/template.yaml` is a full example.

| Key | Meaning |
| --- | --- |
| `title`, `description` | What the list shows. The folder name is the template's name: lower-case letters, digits and hyphens. |
| `compose` | The compose file, in the template's folder. |
| `services` | The compose services a project may run from one of its repos instead of the stand-in: `<service>: { context }`. `context` is the folder inside that repo that its image builds from, `.` for the repo's root. Each service needs a `build` in the compose file: a folder, or `{ context: <folder> }`. |
| `stages` | The setup steps an engineer's task shows, in order: `{ label, waitsFor }`. `waitsFor` names the compose services that must be healthy (or running, without a healthcheck) before the step passes. The `seed` must finish instead: it is the only one-shot service a stage may wait for. Each stage needs its own label, and none may be `Build`: the task lists the stages by label, after Chiefbot's own **Build**. |
| `seed` | The one-shot compose service that fills the database. |
| `notes` | Up to 10 lines for the engineer's brief: the app's URLs and how to sign in as the seeded user. Use dev-only sample values, never secrets. |

Every service, stage and seed the manifest names must be a service of the compose file.

### Ports

The compose file runs the stack in one network namespace, as `java-react-enterprise` does with its `pod` service, so every service is on `localhost` with its fixed port. An engineer's copy of the stack joins the engineer computer's own namespace. So a template must not bind a port the computer uses itself: today only TCP 5900, its screen (VNC).

List the ports the services bind with `expose` on the service that owns the namespace. Control refuses a template when a port that a service binds inside the namespace is one of the computer's ports, with the same protocol (TCP unless the entry says `/udp`), or a range that holds one. That port is an `expose` entry, or the target of a `ports` entry. A published port is on the Docker host, outside the namespace, so `5900:8080` is no clash, and neither is `5900/udp`. Control also refuses a port it cannot read, such as `3000:${PORT}`.

An engineer's stack runs in the computer's namespace (`network_mode: container:…`), where Docker refuses the keys that give a container a network of its own. So the stack removes `ports`, `expose`, `networks`, `links`, `hostname`, `domainname`, `dns`, `dns_search`, `dns_opt`, `extra_hosts` and `mac_address` from every service. A port a template publishes is only for running it by hand.

The computer's ports, each with its protocol, are one list: `computerPorts` in `packages/contracts/src/computer.ts`. The worker reads it, and the computer image gets it as `/opt/chiefbot/ports.env`, which `infra/computer/start.sh` reads. A new port there is checked against every template at once.

## An engineer's stack

Each engineer and each verifier of a project with a template gets its own copy of the stack, inside its own computer's network namespace (`network_mode: container:chiefbot-<id>`). Every service keeps its fixed port on that computer's `localhost`, so the gateway's CORS origin and its cookies work unchanged, and the computer's Chromium reaches the app as a developer's browser does. Two engineers never collide: each has its own `localhost`. No service publishes a port on the Docker host.

After the computer starts, and before its setup clones the repo and runs `commands.setup`, control:

1. Checks the project's `template`, `service` and `services` against the catalog as it is now, and each service's repo against the member who asked for the engineer or verifier, as when settings are saved. It checks on every start, also when the image is already built: the member who saved the settings being able to read a repo is not enough.
2. **Build**: for each service that runs from a repo, finds the commit its `ref` names now, then fetches that commit and builds the service's image from its `context`, tagged `chiefbot-stack-<template>:<service>-<commit>-<repo hash>`. An image that exists is reused, so a later engineer on the same commit skips the fetch and the build. Each stand-in builds from the template's folder, from Docker's build cache once it has built.
3. Starts the services of each of the template's `stages`, in order, as compose project `chiefbot-<id>-stack`, and waits until they are healthy, and the `seed` until it has finished. The seed runs once.

The project's own `service` never starts as a container: the engineer runs it in its computer, after the stack is up. So nothing in the stack may need it (**Use one in a project** refuses such a `service`), and a stage that waits for it is left out. A seed that calls the project's own API without a `depends_on` on it still fails at its stage: compose cannot tell control about that need.

Before Build starts, control lists every stage as waiting. Then each goes into the worker's stack and transcript as it starts, and again as it passes or fails, with the end of its log: its commands' output and what its services said. The project's secrets and the repos' tokens are hidden as the output comes, before it is cut to its end, so no cut leaves a piece of one. The coordinator's `worker_transcript` shows each stage that ended. The engineer's and the verifier's brief say what runs and how to run the project's service, and give the template's `notes`.

A stage that fails ends the job **blocked** (`Its stack did not start: its API stage failed.`), and its agent never starts. So does a check that fails, with a reason that names the key to fix in **Settings**:

- a template or service the catalog no longer has: `Its stack cannot start: services.meta: java-react-enterprise has no service meta. Its services are ui, auth. Fix it in the project's Settings.`;
- a project's own service that a new version of the template needs: `Its stack cannot start: service: ui is needed by the Gateway stage, so it cannot run from the engineer's code. …`;
- a repo the member cannot read: `Its stack cannot start: services.meta: octo-org/meta-api was not found, or your GitHub account cannot see it.`;
- GitHub failing while control checks a repo, which a new dispatch may clear: `… GitHub failed while control checked octo-org/meta-api (…). Try again.`

A verifier blocked this way gets a BLOCKED verdict, with the failed stage's log as its report.

The stack goes when its computer stops, at the end of the worker's turn, and when the computer goes: its containers, volumes and networks, found by the compose project's label. Images stay, for the next engineer. A stack control could not remove, as when Docker did not answer or control stopped first, it removes on its next try or when it starts again, also when the computer has stopped on its own. Only then does it count the computer as stopped.

Control runs stacks with the `docker` CLI and its compose and buildx plugins, on the local Docker provider's Engine (`CHIEFBOT_DOCKER_SOCKET`), and fetches repos with `git`. The control image that `compose.yaml` runs has all three (`infra/control/Dockerfile`). Control run on the host uses the machine's. On the GCE provider, a job of a project with a template ends blocked with `templates need the local Docker provider`. `apps/control/src/templates/stacks.ts` has the stack runner, and `stacks.live.test.ts` beside it runs two stacks of `java-react-enterprise` side by side on real Docker (`CHIEFBOT_DOCKER_TESTS=1 bun test stacks.live`).

### Watch it come up

The task, under its engineer or verifier, and the engineer's transcript in the **Engineers** tab show its setup as one list: the stack's stages (Build, then the template's), then the setup steps that follow (**Clone**, a verifier's **Check out**, and **Setup**, the project's `commands.setup`). Each row has its state (waiting, running, passed or failed) and, for a stage, how long it took, counting while it runs. A row with a log opens it on a click. A failed row's log is open, as it is, with any secret shown as `***`, and the stages after it say **not run**. The list folds into one line, **Set up · 7 steps**, once the engineer's agent starts, and opens again on a click. A list with a failure stays open: the task shows **blocked** and why. While an engineer or verifier of a task handed over by a chief of staff sets up, the chief's handoff card says the stage it is on, such as **Setting up: Database**, until the stack is up.

Control keeps the stages in its database, in the worker's record (`stack` on `GET /projects/:id/workers`, folded from each report) and its transcript, so the list survives a reload of the app and a restart of control.
