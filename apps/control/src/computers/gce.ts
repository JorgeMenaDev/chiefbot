import { z } from "zod";
import type { ComputerId, ComputerProvider } from "./computer.ts";
import type { ComputeClient } from "./compute.ts";

// ComputerProvider on Compute Engine: one VM per bot, made from an instance
// template (machine type, network with no external IP, service account; see
// infra/gcp). The VM runs Container-Optimized OS, which runs the bot computer
// image. The bot's home is its own persistent disk, which outlives the VM.

export type GceProviderOptions = {
  client: ComputeClient;
  project: string;
  zone: string;
  // e.g. projects/<project>/global/instanceTemplates/chiefbot-computer
  instanceTemplate: string;
  // The bot computer image in Artifact Registry.
  image: string;
};

// Compute Engine VM states that count as stopped. The rest (PROVISIONING,
// STAGING, RUNNING, REPAIRING) count as running.
const stoppedStatuses = new Set(["STOPPING", "STOPPED", "TERMINATED", "SUSPENDING", "SUSPENDED"]);

const ApiError = z.object({ httpStatusCode: z.number() });
const httpStatus = (error: unknown) => ApiError.safeParse(error).data?.httpStatusCode;

// Awaits a call, treating the given HTTP statuses as success.
async function allow(call: Promise<void>, ...statuses: number[]) {
  try {
    await call;
  } catch (error) {
    const status = httpStatus(error);
    if (status === undefined || !statuses.includes(status)) throw error;
  }
}

export function gceProvider({ client, project, zone, instanceTemplate, image }: GceProviderOptions): ComputerProvider {
  // Compute Engine names allow lowercase letters, digits and dashes only:
  // bot_<uuid> becomes chiefbot-bot-<uuid> (49 characters, 54 for the disk; the limit is 63),
  // project_<uuid> chiefbot-project-<uuid> (53, 58 for the disk), worker_<uuid> chiefbot-worker-<uuid> (52, 57).
  const vm = (id: ComputerId) => `chiefbot-${id.replaceAll("_", "-").toLowerCase()}`;
  const disk = (id: ComputerId) => `${vm(id)}-home`;

  return {
    async create({ id, env }) {
      // 409: the disk is already there, kept from the bot's previous VM.
      // 50 GB balanced: room for repos, browser profile and SDK history.
      await allow(
        client.insertDisk({ name: disk(id), sizeGb: "50", type: `zones/${zone}/diskTypes/pd-balanced` }),
        409,
      );
      await client.insertInstance(
        {
          name: vm(id),
          // Disks given here replace the template's, so the boot disk is named too.
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: { sourceImage: "projects/cos-cloud/global/images/family/cos-stable", diskSizeGb: "10" },
            },
            {
              source: `projects/${project}/zones/${zone}/disks/${disk(id)}`,
              deviceName: "home",
              autoDelete: false,
            },
          ],
          // Replaces the template's metadata too. OS Login is set project-wide by Terraform.
          metadata: { items: [{ key: "user-data", value: cloudConfig(image, env) }] },
        },
        instanceTemplate,
      );
    },
    // Compute Engine accepts start on a running VM and stop on a stopped one.
    async start(id) {
      await client.startInstance(vm(id));
    },
    async stop(id) {
      await client.stopInstance(vm(id));
    },
    // 404 means it is already gone.
    async destroy(id, { deleteData }) {
      await allow(client.deleteInstance(vm(id)), 404);
      if (deleteData) await allow(client.deleteDisk(disk(id)), 404);
    },
    async status(id) {
      const instance = await client.getInstance(vm(id)).catch((error: unknown) => {
        if (httpStatus(error) === 404) return null;
        throw error;
      });
      if (!instance) return "absent";
      return instance.status && stoppedStatuses.has(instance.status) ? "stopped" : "running";
    },
  };
}

// The cloud-init that Container-Optimized OS runs on every boot. A systemd unit
// mounts the home disk (formatting it on first boot), then runs the bot computer
// image with control's env, locked down as DockerProvider does (docs/isolation.md).
// The container is on Docker's bridge, and a firewall rule drops its traffic to
// the metadata server, so the bot gets no token for the VM's service account.
// On first boot it copies the image's /home/bot onto the empty disk, owner
// included, as Docker does for a new volume.
// The env (with the bot's credential) sits in the VM's metadata, readable by
// project members who can read the VM. It stays there on purpose: see
// docs/deploy-gcp.md, Known limits.
function cloudConfig(image: string, env: Record<string, string>) {
  const registry = image.split("/")[0];
  const envLines = Object.entries(env).map(([key, value]) => `      ${key}=${value}`);
  return `#cloud-config
write_files:
  - path: /etc/chiefbot/env
    permissions: "0600"
    content: |
${envLines.join("\n")}
  - path: /etc/chiefbot/mount-home.sh
    permissions: "0755"
    content: |
      #!/bin/bash
      set -euo pipefail
      dev=/dev/disk/by-id/google-home
      mnt=/mnt/disks/home
      blkid "$dev" >/dev/null || mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$dev"
      mkdir -p "$mnt"
      mountpoint -q "$mnt" || mount -o discard,defaults "$dev" "$mnt"
      if [ ! -e "$mnt/.chiefbot-home" ]; then
        docker run --rm --user root --entrypoint sh -v "$mnt:/disk" ${image} -c 'cp -a /home/bot/. /disk/ && touch /disk/.chiefbot-home'
      fi
  - path: /etc/systemd/system/chiefbot.service
    permissions: "0644"
    content: |
      [Unit]
      Description=Chiefbot bot computer
      Wants=gcr-online.target network-online.target
      After=gcr-online.target network-online.target
      [Service]
      Environment=HOME=/home/chiefbot
      ExecStartPre=/bin/mkdir -p /home/chiefbot
      ExecStartPre=/usr/bin/docker-credential-gcr configure-docker --registries=${registry}
      ExecStartPre=/bin/bash /etc/chiefbot/mount-home.sh
      ExecStartPre=-/usr/bin/docker rm -f chiefbot
      ExecStartPre=/usr/bin/docker pull ${image}
      ExecStartPre=/bin/bash -c 'iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254 -j DROP'
      ExecStart=/usr/bin/docker run --rm --name=chiefbot --init --user=bot --cap-drop=ALL --security-opt=no-new-privileges --env-file=/etc/chiefbot/env -v /mnt/disks/home:/home/bot ${image}
      ExecStop=/usr/bin/docker stop chiefbot
      Restart=always
      RestartSec=10
runcmd:
  - systemctl daemon-reload
  - systemctl start chiefbot.service
`;
}
