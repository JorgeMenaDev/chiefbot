import { expect, test } from "bun:test";
import { ConnectionDefinition, type AgentConnection } from "@chiefbot/contracts";
import { join } from "node:path";
import { approvalFor } from "./approvals.ts";
import { fakeRequest } from "./fakeCopilot.ts";

// The gcloud connection the repo ships, with its real read-only globs.
const { title, cli, env, readOnly } = ConnectionDefinition.parse(Bun.YAML.parse(await Bun.file(join(import.meta.dir, "../../../connections/gcloud/connection.yaml")).text()));
const gcloud: AgentConnection = { name: "gcloud", title, cli, env, readOnly, skill: "", fields: {} };
const asks = (command: string) => approvalFor(fakeRequest.shell(command), [gcloud]) !== null;

test("gcloud's health reads run without asking; anything that may change a project asks", () => {
  const reads = [
    "gcloud run services list",
    "gcloud run services describe hello --region europe-west2 --format json",
    "gcloud run revisions list --service hello --region europe-west2 --limit 5",
    "gcloud container clusters list",
    "gcloud container clusters describe prod --location europe-west2",
    "gcloud container node-pools list --cluster prod --location europe-west2",
    'gcloud monitoring alerts list --filter "state=OPEN"',
    "gcloud monitoring policies list",
    "gcloud monitoring uptime list-configs",
    'gcloud logging read "severity>=ERROR" --freshness 1h --limit 50',
    "gcloud compute regions describe europe-west2",
    "gcloud compute zones describe europe-west2-a",
    "gcloud config list",
  ];
  const writes = [
    "gcloud run deploy hello --image gcr.io/demo/hello",
    "gcloud run services update-traffic hello --to-latest",
    "gcloud run services delete hello --region europe-west2",
    "gcloud container clusters resize prod --num-nodes 0",
    "gcloud container node-pools delete default-pool --cluster prod",
    "gcloud monitoring policies delete projects/demo/alertPolicies/1",
    "gcloud compute instances delete vm-1 --zone europe-west2-a",
    "gcloud auth print-access-token",
    "gcloud iam service-accounts keys create key.json --iam-account bot@demo.iam.gserviceaccount.com",
    // A read with a flag before its group, or chained to a write, asks too.
    "gcloud --project demo run services list",
    "gcloud run services list && gcloud run services delete hello",
  ];

  expect(reads.filter(asks)).toEqual([]);
  expect(writes.filter((command) => !asks(command))).toEqual([]);
});
