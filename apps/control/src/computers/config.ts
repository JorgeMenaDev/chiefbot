import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// Where control runs bot computers, read from its env:
//   CHIEFBOT_COMPUTERS        docker (default) | gce
//   CHIEFBOT_COMPUTER_IMAGE   the bot computer image; default chiefbot-computer:dev for docker, required for gce
//   docker: CHIEFBOT_DOCKER_SOCKET, default DOCKER_HOST's unix socket, else Colima's ~/.colima/default/docker.sock
//           when it exists, else /var/run/docker.sock (Docker Desktop, OrbStack, Linux)
//   gce:    CHIEFBOT_GCP_PROJECT (required), CHIEFBOT_GCP_ZONE (default europe-west2-a, London).
//           VMs come from the instance template chiefbot-computer that infra/gcp creates.
// docker behind a company network (CompanyNetwork, docs/deploy.md): CHIEFBOT_IMAGE_PREFIX,
//           HTTP_PROXY, HTTPS_PROXY and NO_PROXY (or their lower-case forms), CHIEFBOT_CA_FILE.
//           gce reads none of them.

// What engineers' computers and template stacks get behind a company network
// (docs/deploy.md, "Behind a company proxy"). Each is null when unset or empty,
// and then nothing is passed on.
export type CompanyNetwork = {
  // CHIEFBOT_IMAGE_PREFIX, ending in one slash: put before template base images.
  imagePrefix: string | null;
  proxy: { http: string | null; https: string | null; noProxy: string | null };
  // The text of CHIEFBOT_CA_FILE: one PEM certificate or more.
  ca: string | null;
};

// No company network: control's default, and the GCE provider's.
export const noCompanyNetwork: CompanyNetwork = { imagePrefix: null, proxy: { http: null, https: null, noProxy: null }, ca: null };

// The proxy's env for a computer and its stack: each variable in the upper- and
// lower-case forms tools read. NO_PROXY keeps localhost, where the stack's
// services reach each other, and control's own host (`controlUrl`), which the
// computer dials for its WebSocket and git's proxy. Empty with no proxy set.
export function proxyEnv({ proxy }: CompanyNetwork, controlUrl: string): Record<string, string> {
  if (proxy.http === null && proxy.https === null) return {};
  const bypass = [...(proxy.noProxy?.split(",") ?? []), "localhost", "127.0.0.1", "::1", new URL(controlUrl).hostname];
  const noProxy = [...new Set(bypass.map((host) => host.trim()).filter((host) => host !== ""))].join(",");
  return {
    ...(proxy.http === null ? {} : { HTTP_PROXY: proxy.http, http_proxy: proxy.http }),
    ...(proxy.https === null ? {} : { HTTPS_PROXY: proxy.https, https_proxy: proxy.https }),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

// An env setting: unset and empty are the same.
const setting = z
  .string()
  .optional()
  .transform((value) => value || null);

const Env = z.discriminatedUnion("CHIEFBOT_COMPUTERS", [
  z
    .object({
      CHIEFBOT_COMPUTERS: z.literal("docker"),
      CHIEFBOT_COMPUTER_IMAGE: z.string().default("chiefbot-computer:dev"),
      CHIEFBOT_DOCKER_SOCKET: z.string().optional(),
      DOCKER_HOST: z.string().optional(),
      CHIEFBOT_IMAGE_PREFIX: setting,
      HTTP_PROXY: setting,
      http_proxy: setting,
      HTTPS_PROXY: setting,
      https_proxy: setting,
      NO_PROXY: setting,
      no_proxy: setting,
      CHIEFBOT_CA_FILE: setting,
    })
    .transform((env) => ({
      provider: env.CHIEFBOT_COMPUTERS,
      socketPath:
        env.CHIEFBOT_DOCKER_SOCKET ??
        (env.DOCKER_HOST?.startsWith("unix://") ? env.DOCKER_HOST.slice("unix://".length) : undefined),
      image: env.CHIEFBOT_COMPUTER_IMAGE,
      network: {
        imagePrefix: env.CHIEFBOT_IMAGE_PREFIX && `${env.CHIEFBOT_IMAGE_PREFIX.replace(/\/+$/, "")}/`,
        proxy: { http: env.HTTP_PROXY ?? env.http_proxy, https: env.HTTPS_PROXY ?? env.https_proxy, noProxy: env.NO_PROXY ?? env.no_proxy },
      },
      caFile: env.CHIEFBOT_CA_FILE,
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

// Throws with every missing or invalid variable named, and when CHIEFBOT_CA_FILE
// cannot be read or holds no PEM certificate. `exists` checks for Colima's socket.
export function computersConfig(env: Record<string, string | undefined>, homeDir: string, exists = existsSync) {
  const parsed = Env.safeParse({ ...env, CHIEFBOT_COMPUTERS: env.CHIEFBOT_COMPUTERS ?? "docker" });
  if (!parsed.success) throw new Error(`Invalid computers config:\n${z.prettifyError(parsed.error)}`);
  const config = parsed.data;
  if (config.provider === "gce") return config;
  const { caFile, network, ...docker } = config;
  const colima = join(homeDir, ".colima/default/docker.sock");
  return {
    ...docker,
    socketPath: docker.socketPath ?? (exists(colima) ? colima : "/var/run/docker.sock"),
    network: { ...network, ca: caFile === null ? null : caCertificate(caFile) } satisfies CompanyNetwork,
  };
}

// The PEM text of the deployer's CA certificate file, read once.
function caCertificate(file: string) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`CHIEFBOT_CA_FILE: cannot read ${file} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!text.includes("-----BEGIN CERTIFICATE-----")) throw new Error(`CHIEFBOT_CA_FILE: ${file} holds no PEM certificate (-----BEGIN CERTIFICATE-----)`);
  return text;
}
