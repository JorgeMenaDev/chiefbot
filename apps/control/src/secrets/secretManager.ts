import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { z } from "zod";
import type { SecretStore } from "./secretStore.ts";

// The slice of GCP Secret Manager that secretManagerStore needs, in one project.
// Secret ids are the store's names. Failures throw an error with the gRPC `code`
// (5 not found, 6 already exists), as @google-cloud/secret-manager does. Tests
// use fakeSecretManager instead.
export type SecretManagerClient = {
  createSecret(secretId: string): Promise<void>;
  // Resolves with the new version's full name.
  addVersion(secretId: string, data: string): Promise<string>;
  // The latest enabled version's data.
  accessLatest(secretId: string): Promise<string>;
  // Full names of the secret's enabled versions.
  enabledVersions(secretId: string): Promise<string[]>;
  destroyVersion(versionName: string): Promise<void>;
  deleteSecret(secretId: string): Promise<void>;
};

const GrpcError = z.object({ code: z.number() });
const notFound = 5;
const alreadyExists = 6;

async function allow<T>(call: Promise<T>, code: number): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (GrpcError.safeParse(error).data?.code === code) return null;
    throw error;
  }
}

// SecretStore on Secret Manager: one secret per name, its latest version the value.
// Older versions are destroyed on each put: each enabled version is billed.
export function secretManagerStore(client: SecretManagerClient): SecretStore {
  return {
    get: (name) => allow(client.accessLatest(name), notFound),
    async put(name, value) {
      await allow(client.createSecret(name), alreadyExists);
      const latest = await client.addVersion(name, value);
      for (const version of await client.enabledVersions(name)) {
        if (version !== latest) await client.destroyVersion(version);
      }
    },
    async delete(name) {
      await allow(client.deleteSecret(name), notFound);
    },
  };
}

// The real client. Credentials come from Application Default Credentials: on
// the control VM, its service account (roles/secretmanager.admin, infra/gcp).
// Never used in tests.
export function googleSecretManager({ project }: { project: string }): SecretManagerClient {
  const client = new SecretManagerServiceClient();
  const secret = (secretId: string) => `projects/${project}/secrets/${secretId}`;
  return {
    async createSecret(secretId) {
      await client.createSecret({ parent: `projects/${project}`, secretId, secret: { replication: { automatic: {} } } });
    },
    async addVersion(secretId, data) {
      const [version] = await client.addSecretVersion({ parent: secret(secretId), payload: { data: Buffer.from(data) } });
      if (!version.name) throw new Error(`Secret Manager returned no version name for ${secretId}`);
      return version.name;
    },
    async accessLatest(secretId) {
      const [response] = await client.accessSecretVersion({ name: `${secret(secretId)}/versions/latest` });
      return Buffer.from(response.payload?.data ?? "").toString("utf8");
    },
    async enabledVersions(secretId) {
      const [versions] = await client.listSecretVersions({ parent: secret(secretId), filter: "state:ENABLED" });
      return versions.flatMap((version) => (version.name ? [version.name] : []));
    },
    async destroyVersion(name) {
      await client.destroySecretVersion({ name });
    },
    async deleteSecret(secretId) {
      await client.deleteSecret({ name: secret(secretId) });
    },
  };
}
