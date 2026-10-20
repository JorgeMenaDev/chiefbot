---
name: gcloud
description: Check the health of Google Cloud services with the gcloud command, such as Cloud Run services and revisions, GKE clusters and node pools, Cloud Monitoring alerts, alert policies and uptime checks, Cloud Logging errors, and the status of a region or zone. Use when the user mentions Google Cloud, GCP, gcloud, Cloud Run, GKE, a GCP project, region or zone, or asks whether something on Google Cloud is down.
---

# Google Cloud with gcloud

The `gcloud` command is signed in as the user for this turn, with a Google access token that lasts one hour, in `/tmp/chiefbot/connections/gcloud/token`. Never print it or copy it anywhere, and never run `gcloud auth login` or `gcloud init`. If a command fails with 401 or "invalid authentication credentials", the token ran out: tell the user to send a new message, which brings a fresh one.

Commands run in the user's default project (`gcloud config list` shows it). For another one, add `--project <id>` at the end. Put every flag after the command (`gcloud run services list --region europe-west2`, not `gcloud --project x run …`): a read with a flag in front waits for approval. Add `--format json` when you need to read fields.

A 403 that says an API "has not been used in project … or it is disabled" means the project does not use that product (no GKE clusters, say), not that it is down.

## Health recipes (these run without asking)

**Cloud Run.** Services, and whether each is Ready:

```sh
gcloud run services list
gcloud run services describe <service> --region <region> --format "yaml(status.conditions,status.latestReadyRevisionName,status.traffic)"
gcloud run revisions list --service <service> --region <region> --limit 5
```

A service whose `Ready` condition is not `True`, or whose latest revision is not the latest ready one, is unhealthy: describe that revision (`gcloud run revisions describe <revision> --region <region>`) and read its error logs (below).

**GKE.** Cluster and node pool status (`RUNNING` is healthy; `DEGRADED`, `ERROR` or `RECONCILING` are not):

```sh
gcloud container clusters list
gcloud container clusters describe <cluster> --location <location> --format "yaml(status,statusMessage,conditions)"
gcloud container node-pools list --cluster <cluster> --location <location>
gcloud container operations list --filter "status!=DONE"
```

**Cloud Monitoring.** Open alerts (incidents), the alert policies behind them, and uptime checks:

```sh
gcloud monitoring alerts list --filter "state=OPEN"
gcloud monitoring policies list --format "table(displayName,enabled)"
gcloud monitoring uptime list-configs
```

**Cloud Logging.** Recent errors, newest first:

```sh
gcloud logging read "severity>=ERROR" --freshness 1h --limit 50
gcloud logging read 'severity>=ERROR AND resource.type="cloud_run_revision" AND resource.labels.service_name="<service>"' --freshness 1h --limit 20
```

Use `resource.type="k8s_container"` with `resource.labels.cluster_name` for GKE.

**Regions and zones.** A region's or zone's status in the project (`UP` is healthy), and Google's own open incidents for a region from the public status page (no credential needed):

```sh
gcloud compute regions describe <region> --format "value(status)"
gcloud compute zones list --filter "region:<region>"
curl -s https://status.cloud.google.com/incidents.json | bun -e 'for (const i of await Bun.stdin.json()) if (!i.end && i.currently_affected_locations.some((l) => l.id === process.argv[1])) console.log(i.begin, i.service_name, i.severity, i.external_desc)' <region>
```

## Changes

Anything else (`deploy`, `update`, `delete`, `create`, `ssh`, `update-traffic` and the rest) waits for the user's approval in the chat. Say what you are about to do first, and run one change per command so the user approves exactly that.

Reference: https://cloud.google.com/sdk/gcloud/reference
