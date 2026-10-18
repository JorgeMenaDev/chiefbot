# Deploy Chiefbot

Three ways to run Chiefbot, from a laptop to a team's cloud:

| | Control runs | Computers (bots, coordinators, task workers) | HTTPS | Cost |
| --- | --- | --- | --- | --- |
| **Local** | on your Mac (`bun run dev`) | Docker containers on your Mac | none: `http://127.0.0.1:7410` | your Mac |
| **Docker compose** | a container on one Linux machine (`compose.yaml`) | sibling containers on the same machine | Caddy, Let's Encrypt | one machine, flat |
| **GCP** | a container on a small VM (`infra/gcp`) | one Compute Engine VM each | Caddy on the control VM | per hour each computer runs |

Every way needs the two GitHub Apps that `bun run setup` registers (README, Quickstart). Run it once, on a machine with a browser: it writes `~/.chiefbot/config.json` (both apps' IDs) and `github-app-secrets.json` (the repo app's private key). Production copies those two files to the server or into Secret Manager.

What reaches control from where:

- **Members' desktops** reach control on `CHIEFBOT_PUBLIC_URL`. Each member runs the desktop with `CHIEFBOT_CONTROL_URL=<public URL>` and `CHIEFBOT_GITHUB_CLIENT_ID=<the sign-in app's client ID>` (`signIn.app.clientId` in `config.json`, or `signIn.clientId` for an OAuth App), unless they have a `~/.chiefbot/config.json` of their own.
- **Connector OAuth sign-ins** return to `<CHIEFBOT_PUBLIC_URL>/connectors/oauth/callback`. Most OAuth servers accept only an `https` callback on a real name, which is why compose and GCP put Caddy in front of control.
- **Subscriptions** need no inbound route: control polls CI and issue queries itself, outbound, through the project's connectors.
- **Computers** dial control on `CHIEFBOT_WORKER_CONTROL_URL` (their WebSocket, token broker, git proxy and MCP proxy). Nothing dials a computer.

## Local

The README Quickstart: `bun run setup`, `bun run computer:build`, `bun run dev`. Computers reach control on `http://host.docker.internal:7410`.

**On a Linux host** (Docker Engine, not Docker Desktop), `host.docker.internal` is the Docker bridge's address on the host (control maps it for every computer), not the host's loopback. Control on `127.0.0.1` is out of the computers' reach there. Start control with `CHIEFBOT_CONTROL_HOSTNAME=0.0.0.0` and keep port 7410 closed to the outside in the machine's firewall, or use compose.

## Docker compose on one Linux machine

`compose.yaml` runs two containers: **control** and **Caddy**, which gets a Let's Encrypt certificate for your domain and passes every request (WebSockets included) to control. Control runs each computer as a sibling container on the machine's Docker Engine. The computers dial control through Caddy at the same `https://` address members use, so nothing but 80 and 443 is open.

**The Docker socket.** Control mounts `/var/run/docker.sock` to make computers. Access to that socket is root on the machine: anyone who takes over the control container can start a privileged container and own the machine, and with it every computer's files. Control never hands the socket to a computer (`apps/control/src/computers/docker.ts` mounts nothing but each computer's own volume), so a bot that goes wrong cannot reach it. Treat the machine as control's: run nothing else on it, and limit who can SSH in. On GCP, the VM-per-computer path below avoids the socket altogether.

You need a Linux machine with Docker Engine and the compose plugin (`curl -fsSL https://get.docker.com | sh`, then add your user to the `docker` group), a DNS name whose A record points at it, and ports 80 and 443 open. Size it for the computers that run at once: each runs Chromium and the Copilot runtime. Docker needs no other tools: both images build from their Dockerfiles.

1. On your Mac, run `bun run setup` if you have not, then copy the setup files to the server: `scp -r ~/.chiefbot <server>:` . Control reads them from `~/.chiefbot` of the user who runs compose, and writes its `secret.key` there on first start (it encrypts users' refresh tokens; keep it, or everyone signs in again).
2. On the server, clone the repo and name your domain:

   ```bash
   git clone https://github.com/JorgeMenaDev/chiefbot.git && cd chiefbot
   echo "CHIEFBOT_DOMAIN=chiefbot.example.com" > .env
   ```

3. Build the computer image (a few minutes), then start control and Caddy:

   ```bash
   docker compose build computer
   docker compose up -d --build
   ```

4. `docker compose logs control` says `control listening on http://0.0.0.0:7410 with docker computers`. `docker compose logs caddy` says `certificate obtained successfully` for your domain.
5. Run the smoke check below.

SQLite and the projects' context files live in the volume `chiefbot_data`, Caddy's certificates in `chiefbot_caddy-data`.

**New version:** `git pull`, `docker compose build computer`, `docker compose up -d --build`. Control restarts with the new code; new computers use the new image. A bot or project keeps the container it was made with, so delete and recreate a bot to move it to the new image (its files go unless you keep them).

**Back up:** stop control, copy the volume, start it again. Keep `~/.chiefbot` with it.

```bash
docker compose stop control
docker run --rm -v chiefbot_data:/data -v "$PWD":/backup oven/bun:1-slim tar czf /backup/chiefbot-data.tgz -C / data
docker compose start control
```

**Tear down:** delete every bot and project in the app (with **Also delete its files**), then `docker compose down`. `docker compose down -v` also deletes the database and certificates.

## GCP with Terraform

`infra/gcp` puts control on a small VM and each computer on its own Compute Engine VM, in London (`europe-west2`) by default. It is written and validated (`terraform fmt -check`, `terraform validate`), never applied by maintainers. Spending starts at step 4.

**What gets created:**

- **Network:** one VPC and subnet (`10.10.0.0/24`). Computers have no public IP: Cloud NAT gives them outbound internet (GitHub, Copilot, connectors). The firewall lets in SSH through IAP only, computers dialling control's port 7410 inside the network, and 80 and 443 from anywhere to the control VM.
- **Artifact Registry** repository `chiefbot` with two images: `control` and `computer`.
- **Service accounts:** `chiefbot-control` (manages computer VMs and disks; keeps refresh tokens and connector credentials in Secret Manager) and `chiefbot-computer` (pulls its image and writes logs, nothing else).
- **Secrets** `chiefbot-config` and `chiefbot-github-app-secrets`, empty: you add setup's two files as their versions (step 4), so the repo app's key never enters Terraform state. Control reads them on every start into a tmpfs, never onto a disk.
- **Control VM** `chiefbot-control` (e2-medium, Container-Optimized OS) with a static public IP for your domain. It runs the control image and Caddy, with SQLite, context files and Caddy's certificates on its own 10 GB disk.
- **Instance template** `chiefbot-computer`. Control makes one VM from it per bot, project coordinator and task worker (`GceProvider`): e2-standard-2, Container-Optimized OS running the computer image, and a 50 GB home disk each.
- **Budget alert** on the project at 100 a month (50%, 90%, 100% emails to billing admins).

**Why Caddy on the control VM, not a Google load balancer.** An external HTTPS load balancer needs a forwarding rule ($0.025 an hour, about $18 a month), a backend service, an instance group, a health check, a URL map, a target proxy and a managed certificate, and its backend timeout (30 s by default) also cuts WebSockets, which every computer and desktop holds open. Caddy is one container on the VM control already runs on, gets and renews its certificate itself and keeps WebSockets open, for the price of a static IP ($0.005 an hour, about $3.65 a month). The cost: TLS ends on the control VM, which now has a public IP (only 80 and 443 open), and there is no Cloud Armor in front.

**Lifecycle on GCP:** a bot's VM stops after 30 idle minutes, a coordinator's too; a task worker's VM stops as soon as its turn ends and is deleted with its disk when the task is done or abandoned. A stopped VM costs only its disks.

### Steps

You need the `gcloud` CLI, Terraform, Docker with buildx, a billing account ID and a DNS name you control.

1. **Create the project and link billing.**

   ```bash
   gcloud auth login
   gcloud auth application-default login
   gcloud projects create <PROJECT_ID> --name=Chiefbot
   gcloud billing projects link <PROJECT_ID> --billing-account=<BILLING_ACCOUNT_ID>
   gcloud config set project <PROJECT_ID>
   ```

2. **Fill in the variables** in `infra/gcp/terraform.tfvars` (git-ignored). `budget_currency` must be the billing account's currency.

   ```hcl
   project_id         = "<PROJECT_ID>"
   domain             = "chiefbot.example.com"
   billing_account_id = "<BILLING_ACCOUNT_ID>"
   budget_currency    = "USD"
   monthly_budget     = 100
   ```

3. **Review the plan.** It costs nothing and makes no bot, coordinator or worker VMs.

   ```bash
   terraform -chdir=infra/gcp init
   terraform -chdir=infra/gcp plan
   ```

4. **Apply, then add the secrets and the DNS record.** ⚠️ From here the control VM and its IP bill about $38 a month. The control VM retries its image every 10 seconds until step 5 pushes it.

   ```bash
   terraform -chdir=infra/gcp apply
   gcloud secrets versions add chiefbot-config --data-file="$HOME/.chiefbot/config.json"
   gcloud secrets versions add chiefbot-github-app-secrets --data-file="$HOME/.chiefbot/github-app-secrets.json"
   terraform -chdir=infra/gcp output -raw control_ip
   ```

   Point your domain's A record at that IP.

5. **Build and push both images for linux/amd64** from the repo root (on an arm64 Mac, if buildx fails with `exec format error`, run `docker run --privileged --rm tonistiigi/binfmt --install amd64` once):

   ```bash
   gcloud auth configure-docker "$(terraform -chdir=infra/gcp output -raw registry)"
   docker buildx build --platform linux/amd64 --push -f infra/computer/Dockerfile -t "$(terraform -chdir=infra/gcp output -raw computer_image)" .
   docker buildx build --platform linux/amd64 --push -f infra/control/Dockerfile -t "$(terraform -chdir=infra/gcp output -raw control_image)" .
   ```

6. **Check control is up.** Within a few minutes the log says `control listening on http://0.0.0.0:7410 with gce computers`, and Caddy's log shows the certificate.

   ```bash
   gcloud compute ssh chiefbot-control --zone=europe-west2-a --tunnel-through-iap -- 'sudo journalctl -u chiefbot-control -u chiefbot-caddy -n 30'
   ```

7. Run the smoke check below with `https://<your domain>`. On GCP, `gcloud compute instances list` shows `chiefbot-bot-…`, `chiefbot-project-…` and `chiefbot-worker-…` VMs where the compose steps say `docker ps -a`, and TERMINATED where they say Exited.

**New version:** push the images again with the same tag (step 5), then `sudo systemctl restart chiefbot-control` on the control VM. Computer VMs pull their image on every start.

**Rotate the repo app's key:** make a new key on github.com, put it in `github-app-secrets.json`, `gcloud secrets versions add chiefbot-github-app-secrets --data-file=…`, restart control, then delete the old key on github.com.

**Tear down:** delete every bot and project in the app (Terraform does not know their VMs), then `terraform -chdir=infra/gcp destroy`. Check `gcloud compute instances list` and `gcloud compute disks list` are empty, or delete the whole project: `gcloud projects delete <PROJECT_ID>`.

### Known limits

- Users' GitHub refresh tokens are in Secret Manager, one secret `github-refresh-token-<user id>` each, with only the latest version enabled. Access tokens (8 hours) stay in control's SQLite on the data disk.
- A computer's credential (`CHIEFBOT_BOT_TOKEN`, `CHIEFBOT_PROJECT_TOKEN` or `CHIEFBOT_TASK_WORKER_TOKEN`) stays in its VM's metadata. Project members who can read VMs can read it. It gets only that computer's WebSocket to control, and a bot's its owner's access token (at most 8 hours, never a refresh token); everything else, git's proxy included, takes the key of a running turn, which only that WebSocket hands out. It stops working when the bot, project or worker is deleted. Anyone with SSH to the VM could read it anyway. Moving it to Secret Manager needs a host-side fetch on Container-Optimized OS and a service account per computer; revisit when the project gets members with read-only roles such as Compute Viewer.
- No snapshot schedule backs up the control data disk.
- Computers dial control over the private network in plain HTTP; members and OAuth callbacks use HTTPS through Caddy.

## Costs

Monthly, on-demand, USD, no discounts, 730 hours a month. GCP prices are London (`europe-west2`). Sources: machine types from [Compute Engine pricing](https://cloud.google.com/products/compute/pricing/general-purpose) (London rates from gcloud-compute.com's [e2-medium](https://gcloud-compute.com/e2-medium.html), [e2-standard-2](https://gcloud-compute.com/e2-standard-2.html) and [e2-standard-4](https://gcloud-compute.com/e2-standard-4.html) pages, which mirror Google's SKU list), [disk pricing](https://cloud.google.com/compute/disks-image-pricing) (balanced disk in London $0.12 per GB-month, [by region](https://gcloud-compute.com/diskpricing.html)), [static IP and load balancer pricing](https://cloud.google.com/vpc/network-pricing), [Cloud NAT pricing](https://cloud.google.com/nat/pricing), [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing), [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing). IAP TCP forwarding has no charge.

| Item | Rate | Month |
| --- | --- | --- |
| **Compose:** one e2-standard-4 VM (4 vCPU, 16 GB), always on | $0.1727/h | $126.05 |
| Compose: 100 GB balanced disk + static IP | $0.12/GB, $0.005/h | $15.65 |
| **Compose total**, however much the computers run | | **≈ $142** |
| **GCP:** control VM e2-medium, always on | $0.0432/h | $31.54 |
| GCP: control disks (10 GB boot + 10 GB data) + static IP | $0.12/GB, $0.005/h | $6.05 |
| **GCP control total** | | **≈ $38** |
| GCP: a computer's VM e2-standard-2, per hour it runs (incl. Cloud NAT $0.0014/h) | $0.0877/h | per use |
| GCP: a computer's disks (50 GB home + 10 GB boot), while it exists, stopped or not | $0.12/GB | $7.20 ($0.24 a day) |
| GCP: NAT data processing, Artifact Registry, Secret Manager | | ≈ $2 |

A team on GCP for a month: 3 members with a bot each, active 3 hours a working day (22 days); 2 projects whose coordinators are awake 2 hours a working day; 60 tasks, each worker running 45 minutes, each task open 2 days.

| | Hours | Compute | Disks | Total |
| --- | --- | --- | --- | --- |
| 3 bots | 3 × 66 h | $17.36 | 3 × $7.20 | $38.96 |
| 2 coordinators | 2 × 44 h | $7.72 | 2 × $7.20 | $22.12 |
| 60 task workers | 60 × 0.75 h | $3.95 | 60 × 2 days × $0.24 | $32.75 |
| Control and the rest | | | | $40 |
| **Month** | | | | **≈ $134** |

What the stops save: if each worker's VM ran until its task closed (48 hours) instead of stopping when its turn ends, the workers' compute would be $252.58 instead of $3.95. A coordinator never stopped would cost $64 a month instead of $3.86. Workers' disks are now their largest cost: close tasks once their pull requests are merged.

Compose costs the same whatever runs: idle stops free the machine's memory and CPU for other computers, not money. It is cheaper than GCP for a busy team and dearer for a quiet one, and on a provider with cheaper machines than Compute Engine it is cheaper still.

## Smoke check

Run after a compose or GCP deploy, with `https://<domain>` as the public URL. Steps 1 to 3 make no Copilot calls; step 5 makes 2 to 3.

1. `curl -s https://<domain>/me` answers `{"error":"unauthorized"}`, with no certificate warning: Caddy has a valid certificate and reaches control.
2. `curl -s -o /dev/null -w '%{http_code}\n' "https://<domain>/connectors/oauth/callback?state=x"` prints `400` (control's "This sign-in did not work or has expired" page), not `502`: connector OAuth sign-ins can come back to control.
3. On your Mac: `CHIEFBOT_CONTROL_URL=https://<domain> bun run --cwd apps/desktop dev` and sign in with GitHub. Click **+ New bot**. Within a minute or two it turns **online**: its computer reached control through the public URL. `docker ps` on the server (compose) lists `chiefbot-bot_…`. Click **Stop**, then **Delete** with **Also delete its files**.
4. Create a workspace and a project from a repo with a `chiefbot.project.yaml` (README, Projects). `docker ps` lists `chiefbot-project_…`. Leave it alone for 31 minutes (or set `CHIEFBOT_IDLE_STOP_MINUTES=2` for the check): `docker ps -a` shows it **Exited**. Send the coordinator a message: the container is **Up** again within seconds and the coordinator answers.
5. Ask the coordinator to create a small task and dispatch a worker on it. While it works, `docker ps` lists `chiefbot-worker_…`. Once the worker shows **finished**, its container is **Exited** but still listed by `docker ps -a`, with its volume in `docker volume ls`. Mark the task done: the container and its volume are gone.
6. In the project, open **Listening to** and add a CI subscription on a branch. Within 5 minutes **Connector calls** lists an `actions_list` call: polling works with no inbound route.
7. Clean up: delete the project.
