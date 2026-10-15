import type { SecretManagerClient } from "./secretManager.ts";

// An in-memory Secret Manager project for tests. It answers like the real API:
// creating a secret twice is code 6, a missing secret or no enabled version is
// code 5, and a destroyed version is never read again.
export function fakeSecretManager() {
  const secrets = new Map<string, Array<{ name: string; data: string; enabled: boolean }>>();
  const fail = (code: number, message: string) => Object.assign(new Error(message), { code });
  const versionsOf = (secretId: string) => {
    const versions = secrets.get(secretId);
    if (!versions) throw fail(5, `secret ${secretId} not found`);
    return versions;
  };

  const client: SecretManagerClient = {
    async createSecret(secretId) {
      if (secrets.has(secretId)) throw fail(6, `secret ${secretId} already exists`);
      secrets.set(secretId, []);
    },
    async addVersion(secretId, data) {
      const versions = versionsOf(secretId);
      const name = `projects/fake/secrets/${secretId}/versions/${versions.length + 1}`;
      versions.push({ name, data, enabled: true });
      return name;
    },
    async accessLatest(secretId) {
      const latest = versionsOf(secretId).findLast((version) => version.enabled);
      if (!latest) throw fail(5, `secret ${secretId} has no enabled version`);
      return latest.data;
    },
    async enabledVersions(secretId) {
      return versionsOf(secretId).filter((version) => version.enabled).map((version) => version.name);
    },
    async destroyVersion(versionName) {
      const version = [...secrets.values()].flat().find(({ name }) => name === versionName);
      if (!version) throw fail(5, `version ${versionName} not found`);
      version.enabled = false;
      version.data = "";
    },
    async deleteSecret(secretId) {
      versionsOf(secretId);
      secrets.delete(secretId);
    },
  };

  return {
    client,
    enabledVersions: (secretId: string) => secrets.get(secretId)?.filter((version) => version.enabled).length ?? 0,
  };
}
