import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Where control keeps the secrets it must read back: each user's GitHub refresh
// token. Names use letters, digits, `-` and `_` only (Secret Manager's rule).
// localSecretStore (here) encrypts them into control's SQLite; secretManagerStore
// (secretManager.ts) keeps them in GCP Secret Manager.
export type SecretStore = {
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
};

// What control logs of an error that may quote a secret (a SecretStore's, a
// service check's): the error's kind, if a known one, and its numeric code.
// Never its message or any other name, which may quote the value.
const knownErrors = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError"]);
export function secretFailure(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? ` ${error.code}` : "";
  return `${error instanceof Error && knownErrors.has(error.name) ? error.name : "other"}${code}`;
}

// Secrets encrypted with AES-256-GCM under `key` (32 bytes) in a `secrets` table
// of the SQLite file at dbPath. The name is bound in as associated data, so a
// value moved to another name does not decrypt.
export function localSecretStore({ dbPath, key }: { dbPath: string; key: Uint8Array }): SecretStore {
  if (key.length !== 32) throw new Error("The secret key must be 32 bytes");
  const db = new Database(dbPath, { strict: true });
  db.run("CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, sealed TEXT NOT NULL)");

  return {
    async get(name) {
      const row = db.query<{ sealed: string }, [string]>("SELECT sealed FROM secrets WHERE name = ?1").get(name);
      if (!row) return null;
      const sealed = Buffer.from(row.sealed, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(name));
      decipher.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8");
    },
    async put(name, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(name));
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const sealed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
      db.query("INSERT OR REPLACE INTO secrets (name, sealed) VALUES (?1, ?2)").run(name, sealed);
    },
    async delete(name) {
      db.query("DELETE FROM secrets WHERE name = ?1").run(name);
    },
  };
}

// The local store's key: 32 random bytes, base64, in a file readable by its owner
// only. Made on first use. Keep the file outside the repo (default
// ~/.chiefbot/secret.key); losing it means every user signs in again.
export function secretKeyFile(path: string): Uint8Array {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
  }
  return Buffer.from(readFileSync(path, "utf8").trim(), "base64");
}
