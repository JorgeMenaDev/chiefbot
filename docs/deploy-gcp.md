# Deploy Chiefbot to GCP (billing day)

This runbook puts control and the bot computers on Google Cloud in London (`europe-west2`). Nothing here has run yet: the Terraform in `infra/gcp` is written and validated, never applied. Spending starts at step 4.

## What gets created

- **Network:** one VPC and subnet (`10.10.0.0/24`) with no public IPs. Cloud NAT gives outbound internet (GitHub, Copilot). The firewall lets in only IAP (SSH and control's port 7410) and bot VMs dialling control. The bot screen needs no rule of its own: x11vnc listens only inside the bot container, and the worker carries it to control over that same outbound connection.
- **Artifact Registry** repository `chiefbot` with two images: `control` and `computer`.
- **Service accounts:** `chiefbot-control` (manages bot VMs and disks, and keeps users' GitHub refresh tokens in Secret Manager) and `chiefbot-computer` (pulls its image and writes logs, nothing else).
- **Control VM** `chiefbot-control` (e2-medium, Container-Optimized OS) running the control image, with SQLite on its own 10 GB disk.
- **Instance template** `chiefbot-computer`. Control makes one VM per bot from it (`GceProvider`): e2-standard-2, Container-Optimized OS running the bot computer image, and a 50 GB home disk per bot. Stop in the app stops the VM. The home disk survives stop, VM replacement and delete without **Also delete its files**.
- **Budget alert** on the project at 100 a month (50%, 90%, 100% emails to billing admins).

Bot VMs are not in Terraform: control creates them. Delete bots in the app before `terraform destroy`.

## Monthly cost estimate

London on-demand prices, USD, no discounts. Sources: [E2 pricing](https://cloud.google.com/products/compute/pricing/general-purpose) (London rates from the [e2-standard-2](https://gcloud-compute.com/e2-standard-2.html) and [e2-medium](https://gcloud-compute.com/e2-medium.html) pages of gcloud-compute.com, which mirrors Google's SKU list), [disk pricing](https://cloud.google.com/compute/disks-image-pricing) (London balanced disk $0.12 per GB-month, [by region](https://gcloud-compute.com/diskpricing.html)), [Cloud NAT pricing](https://cloud.google.com/nat/pricing), [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing), [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing). IAP TCP forwarding has no charge.

| Item | Rate | Month |
| --- | --- | --- |
| Control VM e2-medium, always on | $0.0432/h | $31.51 |
| Control disks: 10 GB boot + 10 GB data, balanced | $0.12/GB | $2.40 |
| Cloud NAT gateway, control VM | $0.0014/VM-h | $1.02 |
| **Control total** | | **≈ $35** |
| Bot VM e2-standard-2, per active hour (+ NAT $0.0014/h) | $0.0877/h | per use |
| Bot disks: 50 GB home + 10 GB boot, kept while stopped | $0.12/GB | $7.20 per bot |
| NAT data processing | $0.045/GiB | ≈ $1 at 20 GiB |
| Artifact Registry (about 1-2 GB of images, 0.5 GB free) | $0.10/GB | < $0.20 |
| Secret Manager (a few secrets) | $0.06/version | < $0.50 |

Examples:

- **Proof of concept: 2 bots, each active 4 h a day on 22 days:** 2 × 88 h × $0.0877 = $15.44, plus 2 × $7.20 disks, plus $35 control, plus ≈ $1.5 other ≈ **$66 a month**.
- **2 bots never stopped:** 2 × ($63.02 + $7.20 + $1.02) + $35 ≈ **$178 a month**. It passes the $100 budget in about 17 days. Control stops a bot after 30 idle minutes (`CHIEFBOT_IDLE_STOP_MINUTES`), so this happens only to bots kept busy all day.
- Stopping the control VM at night saves about $1 a day.

Research figure for comparison (us-central1): e2-standard-2 ≈ $0.074 per active hour including disk, control ≈ $30 a month. London is about 15-30% higher.

## Steps

You need: the `gcloud` CLI (`brew install --cask google-cloud-sdk`), Terraform (`brew install hashicorp/tap/terraform`), Docker with buildx, and the billing account ID.

1. **Create the project and link billing.** Pick a project ID, for example `chiefbot-poc-2611`.

   ```bash
   gcloud auth login
   gcloud auth application-default login
   gcloud projects create chiefbot-poc-2611 --name=Chiefbot
   gcloud billing accounts list
   gcloud billing projects link chiefbot-poc-2611 --billing-account=<BILLING_ACCOUNT_ID>
   gcloud config set project chiefbot-poc-2611
   ```

2. **Fill in the Terraform variables.** Create `infra/gcp/terraform.tfvars` (git-ignored). Set `budget_currency` to the billing account's currency (shown in the Console under Billing): a budget in the wrong currency fails. `github_client_id` is your GitHub App's client ID: run `bun run setup` first (README quickstart) and copy `githubApp.clientId` from `~/.chiefbot/config.json`.

   ```hcl
   project_id         = "chiefbot-poc-2611"
   github_client_id   = "<YOUR_GITHUB_APP_CLIENT_ID>"
   billing_account_id = "<BILLING_ACCOUNT_ID>"
   budget_currency    = "GBP"
   monthly_budget     = 80
   ```

3. **Review the plan.** It costs nothing. Expect about 28 resources and no bot VMs.

   ```bash
   terraform -chdir=infra/gcp init
   terraform -chdir=infra/gcp plan
   ```

4. **Apply.** ⚠️ From here the control VM and NAT bill about $35 a month.

   ```bash
   terraform -chdir=infra/gcp apply
   ```

   The control VM boots and retries its image every 10 seconds until step 5 pushes it.

   Then copy your GitHub App's config and private key to control's data disk, where control reads them (`CHIEFBOT_HOME=/data/chiefbot`). Control mints the app's installation tokens with the key to reach repos for bots. Without them control stops with "Run `bun run setup`".

   ```bash
   gcloud compute scp ~/.chiefbot/config.json ~/.chiefbot/github-app-secrets.json chiefbot-control:/tmp/ --zone=europe-west2-a --tunnel-through-iap
   gcloud compute ssh chiefbot-control --zone=europe-west2-a --tunnel-through-iap -- 'sudo mkdir -p -m 700 /mnt/disks/data/chiefbot && sudo mv /tmp/config.json /tmp/github-app-secrets.json /mnt/disks/data/chiefbot/ && sudo chmod 600 /mnt/disks/data/chiefbot/*'
   ```

5. **Build and push both images for linux/amd64.** The Mac is arm64, so build with `--platform linux/amd64`. If buildx fails with `exec format error`, run `docker run --privileged --rm tonistiigi/binfmt --install amd64` once.

   ```bash
   gcloud auth configure-docker "$(terraform -chdir=infra/gcp output -raw registry)"
   bun run computer:dist
   docker buildx build --platform linux/amd64 --push -t "$(terraform -chdir=infra/gcp output -raw computer_image)" infra/computer
   bun build apps/control/src/index.ts --target=bun --outfile infra/control/dist/control.js
   docker buildx build --platform linux/amd64 --push -t "$(terraform -chdir=infra/gcp output -raw control_image)" infra/control
   ```

6. **Check control is up.** Within a minute or two the log says `control listening on http://0.0.0.0:7410 with gce computers`.

   ```bash
   gcloud compute ssh chiefbot-control --zone=europe-west2-a --tunnel-through-iap -- sudo journalctl -u chiefbot-control -n 20
   ```

7. **Open the tunnel.** Keep this running in its own terminal. It serves control on `http://127.0.0.1:7410` on the Mac.

   ```bash
   $(terraform -chdir=infra/gcp output -raw control_tunnel)
   ```

8. **Run the desktop against it.** `CHIEFBOT_CONTROL_URL=http://127.0.0.1:7410 bun run --cwd apps/desktop dev`, then sign in with GitHub.

### Live check: a bot gets its own VM

Makes no Copilot calls. Each bot costs about $0.09 per running hour.

1. Click **+ New bot** and name it. `gcloud compute instances list` shows `chiefbot-bot-<uuid>` RUNNING, and `gcloud compute disks list` shows `chiefbot-bot-<uuid>-home`.
2. Within 1-2 minutes the bot turns green (**online**). If it does not, read the VM's log: `gcloud compute ssh chiefbot-bot-<uuid> --zone=europe-west2-a --tunnel-through-iap -- sudo journalctl -u chiefbot -n 50`.
3. Click **Stop**. The VM shows TERMINATED and the bot **stopped**. Click **Start**. It comes back **online**, with the same home disk.
4. Click **Delete**, tick **Also delete its files** and confirm. The VM and its home disk are gone from both lists.

## Day to day

- Control stops a bot's VM after 30 minutes with no running turn, no pending approval, no screen viewer and no routine run (`CHIEFBOT_IDLE_STOP_MINUTES`). **Stop** in the app stops it at once. A stopped bot costs only its disks ($7.20 a month). Its routines start it again when due.
- Stop control when nobody uses Chiefbot: `gcloud compute instances stop chiefbot-control --zone=europe-west2-a`. Bots cannot come online while it is stopped. Start it with `instances start`.
- **New version:** push the images again with the same tag (step 5). For control, run `sudo systemctl restart chiefbot-control` on its VM. Bots pull their image on every start: Stop and Start them in the app.

## Tear down

1. Delete every bot in the app with **Also delete its files** ticked. Terraform does not know about bot VMs.
2. `terraform -chdir=infra/gcp destroy`.
3. Check that `gcloud compute instances list` and `gcloud compute disks list` are empty. To stop every charge at once instead, delete the project: `gcloud projects delete chiefbot-poc-2611`.

## Known limits

- GitHub refresh tokens are in Secret Manager, one secret `github-refresh-token-<user id>` each, with only the latest version enabled. Access tokens (8 hours) and expiry times stay in control's SQLite on the data disk.
- The bot's credential (`CHIEFBOT_BOT_TOKEN`) stays in its VM's metadata (decided in ticket #8). Project members who can read VMs can read it. It gets only that one bot's owner's access token (8 hours at most, never a refresh token) and control's git proxy for repos that owner may use, where every push waits for the owner's approval. It stops working when the bot is deleted. Anyone with SSH to the VM (Owner, Editor, Compute Admin) could read it from the VM anyway. Moving it to Secret Manager needs a host-side fetch on Container-Optimized OS (no `gcloud` or `jq`), a secret per bot, and an IAM grant to the shared `chiefbot-computer` account that lets every bot VM read every bot's secret unless each bot gets its own service account. Revisit when the project gets members with read-only roles such as Compute Viewer.
- No snapshot schedule backs up the control data disk.
- The GitHub App's private key sits on the control VM's data disk (owner-only, root). Anyone with SSH to the control VM can read it. Moving it to Secret Manager is a later step.
