import type { Template } from "@chiefbot/contracts";
import { bearer, unauthorized } from "../http.ts";
import type { openStore } from "../store.ts";

// The template catalog (catalog.ts loadTemplates) as the app lists it (docs/templates.md).
//   GET /templates  bearer session → Template[]: every template the repo ships, in name order
export function templateRoutes({ store, catalog }: { store: ReturnType<typeof openStore>; catalog: Template[] }) {
  return {
    "/templates": {
      GET: (req: Request) => (store.userForSession(bearer(req)) ? Response.json(catalog satisfies Template[]) : unauthorized()),
    },
  };
}
