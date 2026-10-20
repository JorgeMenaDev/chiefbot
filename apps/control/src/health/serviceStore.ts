import type { Database } from "bun:sqlite";
import { Environment, RECENT_SERVICE_CHECKS, Service, ServiceAuth, ServiceCheck, ServiceId, type EnvironmentId, type UserId } from "@chiefbot/contracts";

// People's own services on Health (services.ts), their environments in order,
// and each environment's checks, in control's SQLite. openStore (store.ts) calls
// this once the users table exists. Secrets are never here: they live in the
// SecretStore, keyed by environment. Deleting a service deletes its
// environments and their checks.
export function serviceStore(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // `auth` is a ServiceAuth as JSON; `position` is the order the person gave.
  db.run(`CREATE TABLE IF NOT EXISTS service_environments (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    auth TEXT NOT NULL
  )`);
  // One row per check: a ServiceResult as JSON.
  db.run(`CREATE TABLE IF NOT EXISTS service_checks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    environment_id TEXT NOT NULL REFERENCES service_environments(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    result TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS service_checks_by_environment ON service_checks (environment_id, at)");

  type EnvironmentRow = { id: string; service_id: string; name: string; url: string; auth: string };
  const environmentOf = ({ id, name, url, auth }: EnvironmentRow) => Environment.parse({ id, name, url, auth: ServiceAuth.parse(JSON.parse(auth)) });

  // The person's services (all, or the one `id`), oldest first.
  function services(userId: UserId, id?: ServiceId): Service[] {
    const rows = db
      .query<{ id: string; name: string; icon: string }, [string, string | null]>(
        "SELECT id, name, icon FROM services WHERE user_id = ?1 AND (?2 IS NULL OR id = ?2) ORDER BY created_at, rowid",
      )
      .all(userId, id ?? null);
    const environments = db
      .query<EnvironmentRow, [string, string | null]>(
        `SELECT service_environments.* FROM service_environments JOIN services ON services.id = service_environments.service_id
         WHERE services.user_id = ?1 AND (?2 IS NULL OR services.id = ?2) ORDER BY position`,
      )
      .all(userId, id ?? null);
    return rows.map((row) => Service.parse({ ...row, environments: environments.filter(({ service_id }) => service_id === row.id).map(environmentOf) }));
  }

  return {
    list: (userId: UserId) => services(userId),

    // The person's service `id`, or null when they have none by that id.
    get: (userId: UserId, id: ServiceId) => services(userId, id)[0] ?? null,

    // The person's environment `id`, with its service, or null.
    environment(userId: UserId, id: EnvironmentId): { serviceId: ServiceId; environment: Environment } | null {
      const row = db
        .query<EnvironmentRow, [string, string]>(
          `SELECT service_environments.* FROM service_environments JOIN services ON services.id = service_environments.service_id
           WHERE services.user_id = ?1 AND service_environments.id = ?2`,
        )
        .get(userId, id);
      return row ? { serviceId: ServiceId.parse(row.service_id), environment: environmentOf(row) } : null;
    },

    // Saves the person's service `service` (new, or replacing what it was) with
    // exactly its environments, in their order. An environment that keeps its id
    // keeps its checks; one left out goes, with its checks.
    save(userId: UserId, { id, name, icon, environments }: Service, now: number) {
      db.transaction(() => {
        db.query(
          `INSERT INTO services (id, user_id, name, icon, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, icon = excluded.icon WHERE services.user_id = excluded.user_id`,
        ).run(id, userId, name, icon, now);
        const kept = JSON.stringify(environments.map(({ id }) => id));
        db.query("DELETE FROM service_environments WHERE service_id = ?1 AND id NOT IN (SELECT value FROM json_each(?2))").run(id, kept);
        environments.forEach((environment, position) => {
          db.query(
            `INSERT INTO service_environments (id, service_id, position, name, url, auth) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (id) DO UPDATE SET position = excluded.position, name = excluded.name, url = excluded.url, auth = excluded.auth
             WHERE service_environments.service_id = excluded.service_id`,
          ).run(environment.id, id, position, environment.name, environment.url, JSON.stringify(environment.auth));
        });
      })();
    },

    remove(userId: UserId, id: ServiceId) {
      db.query("DELETE FROM services WHERE user_id = ?1 AND id = ?2").run(userId, id);
    },

    record(id: EnvironmentId, { at, ...result }: ServiceCheck) {
      db.query("INSERT INTO service_checks (environment_id, at, result) VALUES (?1, ?2, ?3)").run(id, at, JSON.stringify(result));
    },

    // The environment's last RECENT_SERVICE_CHECKS checks since `since` (epoch ms), oldest first.
    recent(id: EnvironmentId, since: number): ServiceCheck[] {
      return db
        .query<{ at: number; result: string }, [string, number, number]>(
          "SELECT at, result FROM service_checks WHERE environment_id = ?1 AND at >= ?2 ORDER BY at DESC, seq DESC LIMIT ?3",
        )
        .all(id, since, RECENT_SERVICE_CHECKS)
        .reverse()
        .map(({ at, result }) => ServiceCheck.parse({ ...JSON.parse(result), at }));
    },

    // Deletes every check older than `before`.
    prune(before: number) {
      db.query("DELETE FROM service_checks WHERE at < ?1").run(before);
    },
  };
}
