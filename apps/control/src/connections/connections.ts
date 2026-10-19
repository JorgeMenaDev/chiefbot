import {
  ConnectRequest,
  type AgentConnection,
  type BotId,
  type Connection,
  type ConnectionCallsMessage,
  type ConnectionCall,
  type UserId,
} from "@chiefbot/contracts";
import { z } from "zod";
import { apiError, bearer, unauthorized } from "../http.ts";
import type { SecretStore } from "../secrets/secretStore.ts";
import type { openStore } from "../store.ts";
import type { CatalogConnection } from "./catalog.ts";

// The SecretStore name of a person's secret fields of one connection, as one JSON object.
const secretName = (userId: UserId, name: string) => `connection-${userId}-${name}`;

const SecretFields = z.record(z.string(), z.string());

// Connections: the CLIs of `catalog` (catalog.ts) a person turns on with their own
// fields, which their own bots then use as them (docs/connections.md). Coordinators
// and task workers never get them.
//
// Person routes (a session):
//   GET    /connections                 → Connection[]: the catalog, with `on` for the person
//   PUT    /connections/:name           body ConnectRequest → Connection, on (404 unknown name;
//                                       400 invalid_connection for a missing or unknown field)
//   DELETE /connections/:name           → 204; its fields go, secret ones too
//   GET    /bots/:id/connection-calls   → ConnectionCall[]: the bot's call log, oldest first
// The bot's worker sends a turn's calls on its WebSocket before the turn's done (`logCalls`).
export function connectionHost({ store, secrets, catalog }: { store: ReturnType<typeof openStore>; secrets: SecretStore; catalog: CatalogConnection[] }) {
  const found = (name: string) => catalog.find((connection) => connection.name === name);

  const rows = (userId: UserId): Connection[] => {
    const on = store.connections.on(userId);
    return catalog.map(({ name, title, description, fields }) => ({ name, title, description, fields, on: on.has(name) }));
  };

  // Runs a person route for the signed-in user; 401 otherwise.
  const signedIn =
    <Req extends Request>(handle: (userId: UserId, req: Req) => Response | Promise<Response>) =>
    (req: Req) => {
      const user = store.userForSession(bearer(req));
      return user ? handle(user.id, req) : unauthorized();
    };

  // Saves every field of the connection (secret ones in the SecretStore, the rest
  // in SQLite), replacing what was saved, which turns it on. A field that is
  // missing or not the connection's is refused.
  async function connect(userId: UserId, connection: CatalogConnection, req: Request) {
    const body = ConnectRequest.safeParse(await req.json().catch(() => null));
    if (!body.success) return apiError(400, "invalid_connection", z.prettifyError(body.error));
    const { fields } = body.data;
    const missing = Object.keys(connection.fields).find((field) => !(field in fields));
    if (missing) return apiError(400, "invalid_connection", `${missing} is missing`);
    const unknown = Object.keys(fields).find((field) => !(field in connection.fields));
    if (unknown) return apiError(400, "invalid_connection", `${connection.name} has no field ${unknown}`);
    const isSecret = ([field]: [string, string]) => connection.fields[field]?.secret === true;
    const entries = Object.entries(fields);
    await secrets.put(secretName(userId, connection.name), JSON.stringify(Object.fromEntries(entries.filter(isSecret))));
    store.connections.save(userId, connection.name, Object.fromEntries(entries.filter((entry) => !isSecret(entry))));
    return Response.json(rows(userId).find(({ name }) => name === connection.name) satisfies Connection | undefined);
  }

  const routes = {
    "/connections": {
      GET: signedIn((userId) => Response.json(rows(userId) satisfies Connection[])),
    },
    "/connections/:name": {
      PUT: signedIn((userId, req: Bun.BunRequest<"/connections/:name">) => {
        const connection = found(req.params.name);
        return connection ? connect(userId, connection, req) : apiError(404, "not_found");
      }),
      DELETE: signedIn(async (userId, req: Bun.BunRequest<"/connections/:name">) => {
        const connection = found(req.params.name);
        if (!connection) return apiError(404, "not_found");
        store.connections.remove(userId, connection.name);
        await secrets.delete(secretName(userId, connection.name));
        return new Response(null, { status: 204 });
      }),
    },
    "/bots/:id/connection-calls": {
      GET: signedIn((userId, req: Bun.BunRequest<"/bots/:id/connection-calls">) => {
        const bot = store.botFor(userId, req.params.id);
        return bot ? Response.json(store.connections.calls(bot.id) satisfies ConnectionCall[]) : apiError(404, "not_found");
      }),
    },
  };

  return {
    routes,

    // A bot's worker's calls of its turn `turnId`, sent just before the turn's
    // done: logged only while that turn is one of the bot's unfinished ones, and
    // only for connections in the catalog.
    logCalls(botId: BotId, { turnId, calls }: ConnectionCallsMessage) {
      if (!store.unfinishedTurns(botId).includes(turnId)) return;
      for (const call of calls) if (found(call.connection)) store.connections.logCall(botId, turnId, call);
    },

    // The person's connections that are on, as their bot's computer gets them for
    // a turn: every saved field and the catalog's env templates, skill and
    // read-only commands. Read at each turn's start, so a change applies from the
    // next turn. A field derived from a saved one (a short-lived token minted from
    // a key that stays in control) would be added here.
    async forTurn(userId: UserId): Promise<AgentConnection[]> {
      const on = store.connections.on(userId);
      const connections = await Promise.all(
        catalog.map(async ({ name, title, cli, skill, env, readOnly }): Promise<AgentConnection | null> => {
          const plain = on.get(name);
          if (!plain) return null;
          const secret = SecretFields.safeParse(JSON.parse((await secrets.get(secretName(userId, name))) ?? "null"));
          if (!secret.success) return null;
          return { name, title, cli, skill, env, readOnly, fields: { ...plain, ...secret.data } };
        }),
      );
      return connections.filter((connection) => connection !== null);
    },
  };
}
