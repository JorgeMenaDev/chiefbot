# java-react-enterprise

The first template in the template catalog (`templates/<name>/`, one folder per kind of stack). It is a multi-repo Java and React stack named `acme`, with small generic stand-in services, so it runs out of the box. The stand-ins copy the awkward parts of a typical company stack instead of avoiding them.

**Each service folder stands in for a real repo.** `ui/`, `meta/` and `auth/` each have their own build file and Dockerfile, and nothing is shared between them. A later change lets a project point each service at its real repo.

## Shape

| Service    | Folder      | Port | What it is                                                                                                                                                                                                                                                         |
| ---------- | ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `postgres` | none        | 5432 | PostgreSQL 17. One database, `acme`, with three schemas: `live`, `sandbox` and `experimental`.                                                                                                                                                                     |
| `meta`     | `meta/`     | 8082 | The API. Spring Boot, Java 17, Gradle. Flyway migrates all three schemas at startup. It trusts the gateway's Bearer token (HS256, shared secret) and never checks passwords. Endpoints under `/acme-meta/v1`: `GET /me`, `GET` and `POST /records`, `POST /uploads`. |
| `auth`     | `auth/`     | 8081 | The gateway. Spring Cloud Gateway on WebFlux. Users come from `auth/users.yaml`. It routes `/acme-meta/**` to meta and `/acme-ui/**` to the UI, keeping the path.                                                                                                     |
| `seed`     | `seed/`     | none | A one-shot Node script. Through the gateway, it makes the user's row (`GET /me`), then uploads one CSV per schema, in that order. Safe to run twice.                                                                                                                |
| `ui`       | `ui/`       | 3000 | Next.js with basePath `/acme-ui`. One page lists the `live` records and creates one. The browser calls the gateway at `http://localhost:8081`.                                                                                                                       |

Start order: postgres, meta, auth, seed, ui. Each waits until the one before is healthy (the seed: until it has finished). The stand-in user is `alice`, password `alice-password`.

The awkward parts it keeps on purpose:

- **Fixed ports on `localhost`.** meta reaches the database at `localhost:5432`, the gateway reaches meta at `localhost:8082` and the UI at `localhost:3000`.
- **Auth at the gateway.** It accepts Basic, a Bearer header, or its `auth` cookie. Anything else gets 401 with `WWW-Authenticate: Basic`. A Basic login gets an HS256 token valid for 12 hours, set as the `auth` cookie (`Domain=localhost`, `SameSite=Strict`). Upstream services always get the token as a Bearer header.
- **CORS hard-coded to `http://localhost:3000`**, as real gateways often are.
- **A UI that refuses any port but 3000** (`ui/start.mjs`), since the gateway and its CORS expect it.
- **A dev-only login in the UI** (`ui/proxy.ts`, Next.js 16's name for middleware). With `ACME_DEV_BASIC_AUTH` set, the first page request checks those credentials against meta's identity endpoint, through the gateway, and keeps the gateway's token as a `token` cookie. The page sends it as a Bearer header.
- **A seed that needs auth, meta and a matching user row.** Records belong to a user, so the user row comes first.

## One shared network namespace per copy

`compose.yaml` runs the stack the way Kubernetes runs a pod. A tiny `pod` service (the Kubernetes pause image) owns one network namespace, and every other service joins it with `network_mode: service:pod`. Inside a copy, everything is on `localhost` with the fixed ports above, exactly as a developer runs it on a laptop. `pod` does nothing else, so any app service can restart without taking the namespace with it. Nothing is published to this machine unless you ask.

This is what lets two copies run side by side, unchanged:

- **Ports.** Each copy has its own `localhost`, so both bind 3000, 8081, 8082 and 5432 without a clash. Nothing has to move to another port.
- **CORS.** The UI stays at `http://localhost:3000` in every copy, so the gateway's hard-coded origin is right in every copy.
- **Cookies.** Cookies are scoped by host, not port. Two copies on one host would overwrite each other's `auth` and `token` cookies on `localhost`. Each copy's browser runs inside that copy, with its own `localhost` and its own cookie jar, so nothing is shared.

## Commands

You need Docker with Compose. Images build from source in Docker, so no local JDK or Node is needed.

```bash
./stack.sh up blue              # build and start a copy as compose project acme-blue, wait until healthy
./stack.sh down blue            # remove the copy with its volumes
./stack.sh up blue --publish    # also map the UI and the gateway to this machine
./check.sh                      # the two-copy check (below)
```

With `--publish`, open http://localhost:3000/acme-ui. Only one copy can publish at a time, since every copy wants this machine's 3000 and 8081. A start that fails or is interrupted removes what it created. A copy that existed before is left as it is. One start or removal runs at a time per copy: a second one fails at once.

**The one known limit:** two copies published to one browser, one after the other, share that browser's `localhost` cookies. The second copy gets the first copy's `auth` and `token` cookies. They work there only because every copy signs with the same default secret (`ACME_JWT_SECRET`). Give each published copy its own browser profile or a private window.

## The two-copy check

`./check.sh` builds the images, starts two copies at once, and runs a real browser (Playwright with Chromium, `probe/`) inside each copy's namespace. In each copy the browser:

1. logs in at the gateway with Basic and gets the `auth` cookie;
2. proves the cookie alone gets in: a clean browser with nothing but that cookie reads every seeded record in all three schemas, and gets 401 once the cookie is cleared;
3. opens the UI on port 3000, sees the seeded records and creates one.

Then it confirms that neither copy sees the other's record, and removes both copies with their volumes. Each run names its copies afresh (`acme-check-<random>-a` and `-b`) and removes only those. The check fails if a removal fails, leaves a container, volume or network behind, or Docker cannot list them. It needs Docker, so `bun run check` leaves it out.

The gateway's auth decisions have focused tests (`auth/src/test`). `gradle build` runs them in the gateway's image build, so a failing test fails the image.
