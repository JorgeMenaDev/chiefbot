import { join } from "node:path";
import { z } from "zod";

// Where control runs bot computers, read from its env:
//   CHIEFBOT_COMPUTERS        docker (default) | gce
//   CHIEFBOT_COMPUTER_IMAGE   the bot computer image; default chiefbot-computer:dev for docker, required for gce
//   docker: CHIEFBOT_DOCKER_SOCKET, default DOCKER_HOST's unix socket, else Colima's ~/.colima/default/docker.sock
//   gce:    CHIEFBOT_GCP_PROJECT (required), CHIEFBOT_GCP_ZONE (default europe-west2-a, London).
//           VMs come from the instance template chiefbot-computer that infra/gcp creates.
const Env = z.discriminatedUnion("CHIEFBOT_COMPUTERS", [
  z
    .object({
      CHIEFBOT_COMPUTERS: z.literal("docker"),
      CHIEFBOT_COMPUTER_IMAGE: z.string().default("chiefbot-computer:dev"),
      CHIEFBOT_DOCKER_SOCKET: z.string().optional(),
      DOCKER_HOST: z.string().optional(),
    })
    .transform((env) => ({
      provider: env.CHIEFBOT_COMPUTERS,
      socketPath:
        env.CHIEFBOT_DOCKER_SOCKET ??
        (env.DOCKER_HOST?.startsWith("unix://") ? env.DOCKER_HOST.slice("unix://".length) : undefined),
      image: env.CHIEFBOT_COMPUTER_IMAGE,
    })),
  z
    .object({
      CHIEFBOT_COMPUTERS: z.literal("gce"),
      CHIEFBOT_COMPUTER_IMAGE: z.string().min(1),
      CHIEFBOT_GCP_PROJECT: z.string().min(1),
      CHIEFBOT_GCP_ZONE: z.string().default("europe-west2-a"),
    })
    .transform((env) => ({
      provider: env.CHIEFBOT_COMPUTERS,
      project: env.CHIEFBOT_GCP_PROJECT,
      zone: env.CHIEFBOT_GCP_ZONE,
      instanceTemplate: `projects/${env.CHIEFBOT_GCP_PROJECT}/global/instanceTemplates/chiefbot-computer`,
      image: env.CHIEFBOT_COMPUTER_IMAGE,
    })),
]);

// Throws with every missing or invalid variable named.
export function computersConfig(env: Record<string, string | undefined>, homeDir: string) {
  const parsed = Env.safeParse({ ...env, CHIEFBOT_COMPUTERS: env.CHIEFBOT_COMPUTERS ?? "docker" });
  if (!parsed.success) throw new Error(`Invalid computers config:\n${z.prettifyError(parsed.error)}`);
  const config = parsed.data;
  if (config.provider === "gce") return config;
  return { ...config, socketPath: config.socketPath ?? join(homeDir, ".colima/default/docker.sock") };
}
