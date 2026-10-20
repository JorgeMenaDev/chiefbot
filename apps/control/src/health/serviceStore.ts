import type { Database } from "bun:sqlite";
import { Environment, RECENT_SERVICE_CHECKS, Service, ServiceAuth, ServiceCheck, ServiceId, type EnvironmentId, type UserId } from "@chiefbot/contracts";

// An environment as control checks it: as saved, with the SecretStore name of
// its secret (null when it does not sign). Each secret written gets a new name,
// so a check that took this snapshot never signs with a secret meant for
// another URL: a replaced secret is gone, not changed.
export type SavedEnvironment = Environment & { secretName: string | null };

// People's own services on Health (services.ts), their environments in order,
// and each environment's checks, in control's SQLite. openStore (store.ts) calls
// this once the users table exists. Secrets are never here, only their names in
// the SecretStore. Deleting a service deletes its environments and their checks.
export function serviceStore(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // `auth` is a ServiceAuth as JSON; `position` is the order the person gave;
  // `secret_name` is SavedEnvironment's secretName.
  db.run(`CREATE TABLE IF NOT EXISTS service_environments (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    auth TEXT NOT NULL,
    secret_name TEXT
  )`);
  // One row per check: a ServiceResult as JSON.
  db.run(`CREATE TABLE IF NOT EXISTS service_checks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    environment_id TEXT NOT NULL REFERENCES service_environments(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    result TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS service_checks_by_environment ON service_checks (environment_id, at)");

  type EnvironmentRow = { id: string; service_id: string; name: string; url: string; auth: string; secret_name: string | null };
  const environmentOf = ({ id, name, url, auth }: EnvironmentRow) => Environment.parse({ id, name, url, auth: ServiceAuth.parse(JSON.parse(auth)) });
  const savedOf = (row: EnvironmentRow): SavedEnvironment => ({ ...environmentOf(row), secretName: row.secret_name });

  // The person's environments (of every service, or of the one `id`), each service's in order.
  const environmentRows = (userId: UserId, id: ServiceId | null) =>
    db
      .query<EnvironmentRow, [string, string | null]>(
        `SELECT service_environments.* FROM service_environments JOIN services ON services.id = service_environments.service_id
         WHERE services.user_id = ?1 AND (?2 IS NULL OR services.id = ?2) ORDER BY position`,
      )
      .all(userId, id);

  // The person's services (all, or the one `id`), oldest first.
  function services(userId: UserId, id: ServiceId | null): Service[] {
    const rows = db
      .query<{ id: string; name: string; icon: string }, [string, string | null]>(
        "SELECT id, name, icon FROM services WHERE user_id = ?1 AND (?2 IS NULL OR id = ?2) ORDER BY created_at, rowid",
      )
      .all(userId, id);
    const environments = environmentRows(userId, id);
    return rows.map((row) => Service.parse({ ...row, environments: environments.filter(({ service_id }) => service_id === row.id).map(environmentOf) }));
  }

  // The secret names environments of service `id` hold now.
  const secretNamesOf = (id: ServiceId) =>
    db
      .query<{ secret_name: string }, [string]>("SELECT secret_name FROM service_environments WHERE service_id = ?1 AND secret_name IS NOT NULL")
      .all(id)
      .map(({ secret_name }) => secret_name);

  return {
    list: (userId: UserId) => services(userId, null),

    // The person's service `id`, or null when they have none by that id.
    get: (userId: UserId, id: ServiceId) => services(userId, id)[0] ?? null,

    // The person's environments as saved now (of every service, or of the one `id`), to check.
    saved: (userId: UserId, id: ServiceId | null = null) => environmentRows(userId, id).map(savedOf),

    // The person's environment `id` as saved now, or null.
    environment(userId: UserId, id: EnvironmentId): SavedEnvironment | null {
      const row = db
        .query<EnvironmentRow, [string, string]>(
          `SELECT service_environments.* FROM service_environments JOIN services ON services.id = service_environments.service_id
           WHERE services.user_id = ?1 AND service_environments.id = ?2`,
        )
        .get(userId, id);
      return row ? savedOf(row) : null;
    },

    // Saves the person's service (new, or replacing what it was) with exactly
    // these environments, in their order, all at once. An environment that keeps
    // its id keeps its checks while it checks the same URL the same way, with the
    // same secret; otherwise they describe something else and go. One left out
    // goes, with its checks. Returns the secret names no environment holds any
    // more, for the caller to delete.
    save(userId: UserId, { id, name, icon }: Pick<Service, "id" | "name" | "icon">, environments: SavedEnvironment[], now: number): string[] {
      return db.transaction(() => {
        const before = secretNamesOf(id);
        db.query(
          `INSERT INTO services (id, user_id, name, icon, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, icon = excluded.icon WHERE services.user_id = excluded.user_id`,
        ).run(id, userId, name, icon, now);
        const kept = JSON.stringify(environments.map(({ id }) => id));
        db.query("DELETE FROM service_environments WHERE service_id = ?1 AND id NOT IN (SELECT value FROM json_each(?2))").run(id, kept);
        environments.forEach((environment, position) => {
          const auth = JSON.stringify(environment.auth);
          db.query(
            `DELETE FROM service_checks WHERE environment_id IN (
               SELECT id FROM service_environments WHERE id = ?1 AND service_id = ?2 AND NOT (url = ?3 AND auth = ?4 AND secret_name IS ?5))`,
          ).run(environment.id, id, environment.url, auth, environment.secretName);
          db.query(
            `INSERT INTO service_environments (id, service_id, position, name, url, auth, secret_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (id) DO UPDATE SET position = excluded.position, name = excluded.name, url = excluded.url, auth = excluded.auth, secret_name = excluded.secret_name
             WHERE service_environments.service_id = excluded.service_id`,
          ).run(environment.id, id, position, environment.name, environment.url, auth, environment.secretName);
        });
        const after = new Set(secretNamesOf(id));
        return before.filter((secretName) => !after.has(secretName));
      })();
    },

    // Deletes the person's service `id`; returns the secret names its environments held.
    remove(userId: UserId, id: ServiceId): string[] {
      return db.transaction(() => {
        const owned = db.query<{ id: string }, [string, string]>("SELECT id FROM services WHERE user_id = ?1 AND id = ?2").get(userId, id);
        if (!owned) return [];
        const held = secretNamesOf(id);
        db.query("DELETE FROM services WHERE id = ?1").run(id);
        return held;
      })();
    },

    // Keeps a check of `environment`, unless it no longer checks that URL that
    // way with that secret (saved again meanwhile), or is gone.
    record(environment: SavedEnvironment, { at, ...result }: ServiceCheck) {
      db.query(
        `INSERT INTO service_checks (environment_id, at, result)
         SELECT id, ?2, ?3 FROM service_environments WHERE id = ?1 AND url = ?4 AND auth = ?5 AND secret_name IS ?6`,
      ).run(environment.id, at, JSON.stringify(result), environment.url, JSON.stringify(environment.auth), environment.secretName);
    },

    // The environment's last RECENT_SERVICE_CHECKS checks since `since` (epoch ms),
    // oldest first. A row that is no longer a ServiceCheck is left out, not thrown.
    recent(id: EnvironmentId, since: number): ServiceCheck[] {
      return db
        .query<{ at: number; result: string }, [string, number, number]>(
          "SELECT at, result FROM service_checks WHERE environment_id = ?1 AND at >= ?2 ORDER BY at DESC, seq DESC LIMIT ?3",
        )
        .all(id, since, RECENT_SERVICE_CHECKS)
        .reverse()
        .flatMap(({ at, result }) => {
          const check = ServiceCheck.safeParse({ ...JSON.parse(result), at });
          return check.success ? [check.data] : [];
        });
    },

    // Deletes every check older than `before`.
    prune(before: number) {
      db.query("DELETE FROM service_checks WHERE at < ?1").run(before);
    },
  };
}
