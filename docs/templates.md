# Templates

A **template** is a kind of service stack an engineer can get beside its code: for example a UI with its API, its gateway, a database and a seed step. Chiefbot ships a catalog of them in `templates/`, one folder each, as it ships connections in `connections/`. The first is `java-react-enterprise` (`templates/java-react-enterprise/README.md`).

Engineers do not get a template's services yet. Control loads and lists the catalog. Picking a template for a project and giving each engineer its own copy of the stack come next.

## See them

Open the gear menu at the bottom left of the sidebar and click **Connect apps**. **Templates**, under your connections, lists each template:

- its title and folder name;
- what it runs;
- **From a repo**: the services a project may run from its own repos instead of the stand-ins;
- **Setup**: its stages in order, each with the compose services it waits for.

The list is read-only. A template changes only with the repo. Control serves the list at `GET /templates`.

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
