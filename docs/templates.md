# Templates

A **template** is a kind of service stack an engineer can get beside its code: for example a UI with its API, its gateway, a database and a seed step. Chiefbot ships a catalog of them in `templates/`, one folder each, as it ships connections in `connections/`. The first is `java-react-enterprise` (`templates/java-react-enterprise/README.md`).

Control loads and lists the catalog, and a project picks a template (**Use one in a project**, below). Engineers do not get a template's services yet: giving each engineer its own copy of the stack comes next.

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

- `service` is the service the project's own repo is. It never runs as a container: each engineer will run it from its own clone, through `commands.setup` and `commands.dev`, so its edits show live. `services` cannot name it.
- Each entry of `services` is `{ repo, ref }` or `stand-in`. A repo's image builds from the service's `context` in that repo, at `ref`, a branch or tag. `ref` follows git's ref-name rules (`git check-ref-format`) and cannot start with `-`. Both keys are required, and no other key is allowed. A service that `services` leaves out runs its stand-in.
- The settings override the file key by key, as for the other keys. `template`, `service` and `services` are each taken whole, so the settings' `services` replaces the file's. Settings without `template` take the file's. `template: null` in the settings turns templates off, and the file's `service` and `services` with them.

Control checks the keys against the catalog when it reads the file, as the project is made, and when settings are saved. It refuses:

- a template that is not in the catalog;
- a service the template does not have, in `service` or in `services`. Only the template's `services` count: a compose service such as `postgres` does not;
- `services` naming the project's own service, or pointing another service at the project's own repo;
- a template without `service`, or `service` or `services` without a template;
- a repo the member cannot read, checked as for the project's own repo: through the repo app, or as a public repo where the app is not installed. A save checks the repos its settings name, as the member who saves.

A file that breaks one of these rules is invalid: the project uses its settings alone, and **Settings** shows the error. Settings that break one are not saved (`invalid_settings`), and the error names the key. If GitHub fails while control checks a repo (a 5xx, a lost connection), control makes no project and saves nothing, and answers `github_failed` (502): try again.

When engineers get stacks, a stack checks each service's repo against the member who starts the engineer or verifier, every time, cached builds included. The member who saved the settings being able to read it is not enough.

In the app, open the project's gear. **Template and services** has a picker with the catalog. Under it you pick the service this repo is, and for each other service **Stand-in** or **A repo**, with its repo and branch or tag. The project's own service is marked **This repo** and has no repo to pick. **None** writes `template: null`, and says **(overrides the project file)** when the file sets a template. **Save** writes the keys into the settings and keeps their other keys and comments, those on `services` and its entries included. **Config** then shows each key with its source. While the YAML under **Settings** has unsaved edits, the picker cannot save, because its save would drop them: save or undo them first.

## Add one

A template is a folder, `templates/<name>/`, with a `template.yaml`, a compose file and the stand-in services the compose file builds. Control reads every folder when it starts (`CHIEFBOT_TEMPLATES_DIR`, default the repo's `templates`). If one is wrong, control refuses to start and names the file and the problem. No code changes.

`template.yaml` holds only what Chiefbot needs that compose cannot say. An unknown key is an error, and each YAML file may hold up to 256 KB. `templates/java-react-enterprise/template.yaml` is a full example.

| Key | Meaning |
| --- | --- |
| `title`, `description` | What the list shows. The folder name is the template's name: lower-case letters, digits and hyphens. |
| `compose` | The compose file, in the template's folder. |
| `services` | The compose services a project may run from one of its repos instead of the stand-in: `<service>: { context }`. `context` is the folder inside that repo that its image builds from, `.` for the repo's root. Each service needs a `build` in the compose file: a folder, or `{ context: <folder> }`. |
| `stages` | The setup steps an engineer's task shows, in order: `{ label, waitsFor }`. `waitsFor` names the compose services that must be healthy before the step passes. A one-shot service must finish instead. |
| `seed` | The one-shot compose service that fills the database. |
| `notes` | Up to 10 lines for the engineer's brief: the app's URLs and how to sign in as the seeded user. Use dev-only sample values, never secrets. |

Every service, stage and seed the manifest names must be a service of the compose file.

### Ports

The compose file runs the stack in one network namespace, as `java-react-enterprise` does with its `pod` service, so every service is on `localhost` with its fixed port. An engineer's copy of the stack will join the engineer computer's own namespace. So a template must not bind a port the computer uses itself: today only TCP 5900, its screen (VNC).

List the ports the services bind with `expose` on the service that owns the namespace. Control refuses a template when a port that a service binds inside the namespace is one of the computer's ports, with the same protocol (TCP unless the entry says `/udp`), or a range that holds one. That port is an `expose` entry, or the target of a `ports` entry. A published port is on the Docker host, outside the namespace, so `5900:8080` is no clash, and neither is `5900/udp`. Control also refuses a port it cannot read, such as `3000:${PORT}`.

When a stack runs in the computer's namespace (`network_mode: container:…`), the stack runner must remove `expose` and `ports` from its services, because Docker refuses them in that mode.

The computer's ports, each with its protocol, are one list: `computerPorts` in `packages/contracts/src/computer.ts`. The worker reads it, and the computer image gets it as `/opt/chiefbot/ports.env`, which `infra/computer/start.sh` reads. A new port there is checked against every template at once.
