import {
  EnvironmentInput,
  MAX_ENVIRONMENTS,
  RECENT_SERVICE_CHECKS,
  savedSecretKept,
  Service,
  ServiceInput,
  ServiceIcon,
  ServiceResult,
  worstStatus,
  type Environment,
  type EnvironmentHealth,
  type HealthStatus,
  type ServiceAuth,
  type ServiceCheck,
  type ServiceHealth,
} from "@chiefbot/contracts";
import {
  BracesIcon,
  DatabaseIcon,
  EllipsisIcon,
  GlobeIcon,
  KeyRoundIcon,
  LockIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { option } from "./NewBot.tsx";
import { ErrorText } from "./Pane.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Card } from "./components/ui/card.tsx";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "./components/ui/dialog.tsx";
import { EmptyMedia } from "./components/ui/empty.tsx";
import { Input } from "./components/ui/input.tsx";
import { MenuItem, MenuPopup, MenuSeparator } from "./components/ui/menu.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { ago, badgeVariant, barColor, clock, StatusIcon } from "./healthStatus.tsx";
import { cn } from "./lib/utils.ts";

// Services on Health: the person's own health URLs, each service in one or more
// environments. Control checks them when Health opens, on Refresh and on Check
// now (services.ts in control). A card lists them, a block per service and a row
// per environment; the Add/Edit dialog tests an environment before it is saved.

export const serviceIcons: Record<ServiceIcon, { icon: LucideIcon; label: string }> = {
  web: { icon: GlobeIcon, label: "Web app" },
  api: { icon: BracesIcon, label: "API" },
  auth: { icon: KeyRoundIcon, label: "Auth" },
  data: { icon: DatabaseIcon, label: "Data" },
  messaging: { icon: MessagesSquareIcon, label: "Messaging" },
  other: { icon: ServerIcon, label: "Other" },
};

// A service is degraded only when it answers slowly.
export const serviceLabel: Record<HealthStatus, string> = { ok: "Healthy", degraded: "Slow", down: "Down", unknown: "Unknown" };

// What the Services card does, from Health (Health.tsx), which owns the dialog and the checks.
export type ServiceActions = {
  // Whether the service is being checked now.
  checking: (service: Service) => boolean;
  onAdd: () => void;
  onEdit: (service: Service) => void;
  onRemove: (service: Service) => void;
  onCheck: (service: Service) => void;
  // Opens a bot's chat with the text written in; null without a bot.
  onAsk: ((text: string) => void) | null;
};

// The card under the connection cards: a block per service, or how to add one.
export function ServicesCard({ services, now, actions }: { services: ServiceHealth[]; now: number; actions: ServiceActions }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2.5">
        <h3 className="font-medium text-sm">Services</h3>
        {services.length > 0 && (
          <Button size="xs" variant="outline" className="ms-auto" onClick={actions.onAdd}>
            <PlusIcon />
            Add service
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">Your own health URLs, in each environment. Health checks them when you open it and on Refresh.</p>
      {services.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed px-6 py-8 text-center">
          <EmptyMedia className="mb-4">
            <ServerIcon />
          </EmptyMedia>
          <p className="font-medium text-sm">No services yet</p>
          <p className="max-w-sm text-balance text-muted-foreground text-xs">
            Add the health URL of something you run, like a web app or an API, for prod and each other environment it runs in.
          </p>
          <Button size="sm" variant="outline" className="mt-3" onClick={actions.onAdd}>
            <PlusIcon />
            Add service
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col border-t">
          {services.map((service) => (
            <ServiceBlock key={service.id} service={service} now={now} actions={actions} />
          ))}
        </ul>
      )}
    </Card>
  );
}

// The worst latest status of `checks`, or null while one is unchecked and the rest are healthy.
function rollUp(checks: Array<ServiceCheck | null>) {
  const done = checks.filter((check) => check !== null);
  const worst = done.length > 0 ? worstStatus(done.map(({ status }) => status)) : null;
  return done.length < checks.length && (worst === null || worst === "ok") ? null : worst;
}

// A service: its icon, name, the worst of its environments and its menu, then a row per environment.
function ServiceBlock({ service, now, actions }: { service: ServiceHealth; now: number; actions: ServiceActions }) {
  const menu = useId();
  const { icon: Icon, label } = serviceIcons[service.icon];
  const latest = service.environments.map(({ latest }) => latest);
  const status = rollUp(latest);
  const last = Math.max(...latest.map((check) => check?.at ?? 0));
  const checking = actions.checking(service);
  return (
    <li className="flex flex-col gap-2 border-b py-3.5 last:border-b-0 last:pb-0">
      <div className="flex items-center gap-2.5">
        <span title={label} className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
          <Icon aria-hidden className="size-3.5" />
        </span>
        <h4 className="min-w-0 truncate font-medium text-sm">{service.name}</h4>
        <Badge variant={status ? badgeVariant[status] : "outline"}>{status ? serviceLabel[status] : "Not checked yet"}</Badge>
        <span className="ms-auto flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs tabular-nums">
          {checking ? (
            <>
              <Spinner className="size-3" />
              Checking…
            </>
          ) : (
            last > 0 && `Checked ${ago(last, now)}`
          )}
        </span>
        <Button size="icon-xs" variant="ghost" aria-label={`${service.name}: more`} title="More" popoverTarget={menu}>
          <EllipsisIcon />
        </Button>
        <MenuPopup id={menu} aria-label={service.name} className="mt-1 mb-0 min-w-40 origin-top-right [position-area:bottom_span-left]">
          <MenuItem menu={menu} disabled={checking} onClick={() => actions.onCheck(service)}>
            <RefreshCwIcon />
            Check now
          </MenuItem>
          <MenuItem menu={menu} onClick={() => actions.onEdit(service)}>
            <PencilIcon />
            Edit
          </MenuItem>
          <MenuSeparator />
          <MenuItem menu={menu} variant="destructive" onClick={() => actions.onRemove(service)}>
            <Trash2Icon />
            Remove
          </MenuItem>
        </MenuPopup>
      </div>
      <ul className="flex flex-col gap-1.5 ps-8.5">
        {service.environments.map((environment) => (
          <EnvironmentRow key={environment.id} service={service.name} environment={environment} onAsk={actions.onAsk} />
        ))}
      </ul>
    </li>
  );
}

// One environment: its tag, URL, recent checks, status and what the last check
// measured; when it is not healthy, what is wrong and Ask my bot.
function EnvironmentRow({ service, environment, onAsk }: { service: string; environment: EnvironmentHealth; onAsk: ((text: string) => void) | null }) {
  const { name, url, latest, recent } = environment;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <Badge variant="outline" title={name} className="w-17 justify-start font-mono">
          <span className="truncate">{name}</span>
        </Badge>
        <span title={url} className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {url}
        </span>
        <RecentChecks recent={recent} />
        <span className="flex w-16 shrink-0">
          <Badge variant={latest ? badgeVariant[latest.status] : "outline"}>{latest ? serviceLabel[latest.status] : "Not checked"}</Badge>
        </span>
        <span title={latest ? measured(latest) : undefined} className="w-28 shrink-0 truncate text-end text-muted-foreground text-xs tabular-nums">
          {latest ? measured(latest) : ""}
        </span>
      </div>
      {latest && latest.status !== "ok" && (
        <div className="flex items-center gap-2 ps-20">
          <StatusIcon status={latest.status} className="size-3.5" />
          <span className="min-w-0 flex-1 text-foreground text-xs leading-snug">
            <span className="sr-only">{serviceLabel[latest.status]}: </span>
            {latest.problem ?? serviceLabel[latest.status]}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={!onAsk}
            title={onAsk ? "Open a bot's chat with this problem written in" : "Create a bot first"}
            onClick={onAsk ? () => onAsk(askServiceText(service, environment, latest)) : undefined}
          >
            <MessageSquareIcon />
            Ask my bot
          </Button>
        </div>
      )}
    </li>
  );
}

// "200 · UP · 84 ms", "No answer", "503 · DOWN · 1.2 s".
export function measured({ code, bodyStatus, latencyMs }: ServiceResult) {
  const parts = [code === null ? "No answer" : String(code), bodyStatus, latencyMs === null ? null : latency(latencyMs)];
  return parts.filter((part) => part !== null).join(" · ");
}

const latency = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// The message Ask my bot writes into the chat: the service, the environment, its URL and
// what the check found, never a secret.
export const askServiceText = (service: string, { name, url }: Pick<Environment, "name" | "url">, check: ServiceResult) =>
  `My ${service} service's ${name} health check says: ${check.problem ?? serviceLabel[check.status]}\nGET ${url} → ${measured(check)}\n\nFind out why, and tell me what to do about it.`;

// An environment's latest checks as a row of ticks, oldest first, after a status
// page's uptime bar; the slots before its first check are the track.
function RecentChecks({ recent }: { recent: ServiceCheck[] }) {
  const counts = (["down", "degraded", "unknown", "ok"] as const)
    .map((status) => [status, recent.filter((check) => check.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${serviceLabel[status].toLowerCase()}`);
  const label = recent.length > 0 ? `Last ${recent.length === 1 ? "check" : `${recent.length} checks`}: ${counts.join(", ")}` : "No checks in the last 24 hours";
  return (
    <div role="img" aria-label={label} className="flex h-3.5 w-24 shrink-0 gap-0.5">
      {Array.from({ length: RECENT_SERVICE_CHECKS - recent.length }, (_, index) => (
        <span key={`track-${index}`} className="flex-1 rounded-full bg-muted" />
      ))}
      {recent.map((check, index) => (
        <span
          key={`${check.at}-${index}`}
          title={`${serviceLabel[check.status]} · ${clock(check.at)} · ${check.problem ?? measured(check)}`}
          className={cn("flex-1 rounded-full", barColor[check.status])}
        />
      ))}
    </div>
  );
}

// One environment in the dialog: what is typed, and what was saved for it.
type Draft = {
  key: string;
  saved: Environment | null;
  name: string;
  url: string;
  auth: ServiceAuth["kind"];
  header: string;
  // A secret typed now; "" for none.
  secret: string;
  // Replace was clicked on a saved secret.
  replacing: boolean;
  // The URL lost focus once, so a problem with it shows (not while it is typed).
  urlLeft: boolean;
  test: { busy: boolean; result: ServiceResult | null; error: string | null };
};

const suggestedNames = ["prod", "preprod", "int"];
const idle = { busy: false, result: null, error: null };

export const draftOf = (saved: Environment): Draft => ({
  key: saved.id,
  saved,
  name: saved.name,
  url: saved.url,
  auth: saved.auth.kind,
  header: saved.auth.kind === "header" ? saved.auth.header : "",
  secret: "",
  replacing: false,
  urlLeft: true,
  test: idle,
});

const authOf = ({ auth, header }: Draft): ServiceAuth => (auth === "header" ? { kind: "header", header } : { kind: auth });

// Whether the draft keeps its saved secret: no new one asked for.
const keepsSecret = (draft: Draft) => !draft.replacing && savedSecretKept(draft.saved ?? undefined, { url: draft.url, auth: authOf(draft) });

// The draft as control takes it: the secret only when one is typed and needed.
const inputOf = (draft: Draft): EnvironmentInput => ({
  ...(draft.saved ? { id: draft.saved.id } : {}),
  name: draft.name,
  url: draft.url,
  auth: authOf(draft),
  ...(draft.auth !== "none" && !keepsSecret(draft) && draft.secret.trim() !== "" ? { secret: draft.secret } : {}),
});

// The drafts once the Test of `tested` (the draft as it was when Test was
// clicked) ends with `outcome`. A draft edited since gets none: the outcome
// would describe what it no longer says.
export const afterTest = (drafts: Draft[], tested: Draft, outcome: Draft["test"]) =>
  drafts.map((draft) => (draft.key === tested.key && JSON.stringify(inputOf(draft)) === JSON.stringify(inputOf(tested)) ? { ...draft, test: outcome } : draft));

// Whether a draft that signs still lacks its secret.
const lacksSecret = (draft: Draft) => draft.auth !== "none" && !keepsSecret(draft) && draft.secret.trim() === "";

// Whether `url` would carry a secret over plain http to another computer.
export function plainHttpToAnotherHost(url: string, auth: ServiceAuth["kind"]) {
  if (auth === "none") return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

// Add service, or Edit service with `service`: its name and icon, then a card
// per environment with its URL, authentication, secret (write-only: a saved one
// shows as saved, with Replace) and Test. Open while mounted; Cancel, Escape or
// a saved service call onClose, and a saved one calls onSaved first.
export function ServiceDialog({ service, onSaved, onClose }: { service: Service | null; onSaved: (service: Service) => void; onClose: () => void }) {
  const titleId = useId();
  const suggestions = useId();
  const [name, setName] = useState(service?.name ?? "");
  const [icon, setIcon] = useState<ServiceIcon>(service?.icon ?? "web");
  const [drafts, setDrafts] = useState<Draft[]>(() => service?.environments.map(draftOf) ?? [blankDraft([])]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = ServiceInput.safeParse({ name, icon, environments: drafts.map(inputOf) });
  const ready = parsed.success && !drafts.some(lacksSecret);
  // A field's problem, shown once something is typed in it.
  const issue = (index: number, field: "name" | "url" | "auth") =>
    parsed.success ? null : (parsed.error.issues.find(({ path }) => path[0] === "environments" && path[1] === index && path[2] === field)?.message ?? null);

  const update = (key: string, change: Partial<Draft>) =>
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...change, test: "test" in change ? (change.test ?? idle) : idle } : draft)));

  async function test(draft: Draft) {
    update(draft.key, { test: { busy: true, result: null, error: null } });
    const ended = (outcome: Draft["test"]) => setDrafts((current) => afterTest(current, draft, outcome));
    try {
      const result = ServiceResult.parse(await window.chiefbot.health.testEnvironment(EnvironmentInput.parse(inputOf(draft))));
      ended({ busy: false, result, error: null });
    } catch (caught) {
      ended({ busy: false, result: null, error: caught instanceof Error ? caught.message : String(caught) });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!parsed.success || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const saved = Service.parse(service ? await window.chiefbot.health.updateService(service.id, parsed.data) : await window.chiefbot.health.addService(parsed.data));
      onSaved(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} aria-labelledby={titleId} className="max-h-[calc(100dvh-2rem)] max-w-xl">
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
        <DialogHeader>
          <DialogTitle id={titleId}>{service ? "Edit service" : "Add service"}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-1 flex-col gap-5 space-y-0 overflow-y-auto pt-1">
          <label className="flex flex-col gap-1.5 font-medium text-foreground text-xs">
            Name
            <Input autoFocus placeholder="Meta service" maxLength={40} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
          </label>
          <fieldset disabled={busy} className="flex flex-col gap-1.5">
            <legend className="mb-1.5 font-medium text-foreground text-xs">Icon</legend>
            <div className="flex flex-wrap gap-2">
              {Object.entries(serviceIcons).map(([value, { icon: Icon, label }]) => (
                <label key={value} title={label} className={cn(option, "size-10 text-muted-foreground hover:bg-accent has-checked:text-foreground")}>
                  <input type="radio" name="icon" aria-label={label} className="sr-only" checked={icon === value} onChange={() => setIcon(ServiceIcon.parse(value))} />
                  <Icon aria-hidden className="size-4.5" />
                </label>
              ))}
            </div>
          </fieldset>
          <section className="flex flex-col gap-2">
            <h3 className="font-medium text-foreground text-xs">Environments</h3>
            <datalist id={suggestions}>
              {suggestedNames.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
            {drafts.map((draft, index) => (
              <EnvironmentCard
                key={draft.key}
                draft={draft}
                suggestions={suggestions}
                busy={busy}
                issue={(field) => issue(index, field)}
                onChange={(change) => update(draft.key, change)}
                onTest={() => void test(draft)}
                onRemove={drafts.length > 1 ? () => setDrafts(drafts.filter(({ key }) => key !== draft.key)) : null}
              />
            ))}
            {drafts.length < MAX_ENVIRONMENTS && (
              <Button size="xs" variant="ghost" className="self-start" disabled={busy} onClick={() => setDrafts([...drafts, blankDraft(drafts)])}>
                <PlusIcon />
                Add environment
              </Button>
            )}
          </section>
          <ErrorText message={error} />
        </DialogPanel>
        <DialogFooter>
          {busy && (
            <p className="flex items-center gap-1.5 text-muted-foreground text-xs sm:me-auto">
              <Spinner className="size-3" />
              Saving…
            </p>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !ready}>
            {service ? "Save" : "Add service"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// A new environment, named after the first suggestion the others do not use.
function blankDraft(others: Draft[]): Draft {
  const used = new Set(others.map(({ name }) => name.trim().toLowerCase()));
  return {
    key: crypto.randomUUID(),
    saved: null,
    name: suggestedNames.find((suggestion) => !used.has(suggestion)) ?? "",
    url: "",
    auth: "none",
    header: "",
    secret: "",
    replacing: false,
    urlLeft: false,
    test: idle,
  };
}

const authOptions = [
  { kind: "none", label: "None" },
  { kind: "bearer", label: "Bearer token" },
  { kind: "header", label: "Header" },
] as const;

// One environment's card in the dialog.
function EnvironmentCard({
  draft,
  suggestions,
  busy,
  issue,
  onChange,
  onTest,
  onRemove,
}: {
  draft: Draft;
  suggestions: string;
  busy: boolean;
  issue: (field: "name" | "url" | "auth") => string | null;
  onChange: (change: Partial<Draft>) => void;
  onTest: () => void;
  onRemove: (() => void) | null;
}) {
  const authName = useId();
  const keeps = keepsSecret(draft);
  const secretLabel = draft.auth === "bearer" ? "Token" : "Value";
  const problems = [draft.name.trim() ? issue("name") : null, draft.urlLeft && draft.url.trim() ? issue("url") : null, draft.header.trim() ? issue("auth") : null].filter(
    (problem) => problem !== null,
  );
  const testable = EnvironmentInput.safeParse(inputOf(draft)).success && !lacksSecret(draft);
  const { result, error } = draft.test;
  return (
    <fieldset disabled={busy} className="flex flex-col gap-3 rounded-xl border bg-muted/24 p-3 dark:bg-input/16">
      <legend className="sr-only">{draft.name || "New environment"}</legend>
      <div className="flex items-end gap-2">
        <label className="flex w-28 shrink-0 flex-col gap-1.5 font-medium text-foreground text-xs">
          Environment
          <Input list={suggestions} placeholder="prod" maxLength={20} value={draft.name} onChange={(event) => onChange({ name: event.target.value })} />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 font-medium text-foreground text-xs">
          Health URL
          <Input
            type="url"
            inputMode="url"
            spellCheck={false}
            placeholder="https://api.example.com/actuator/health"
            value={draft.url}
            onChange={(event) => onChange({ url: event.target.value })}
            onBlur={() => {
              if (!draft.urlLeft) onChange({ urlLeft: true, test: draft.test });
            }}
          />
        </label>
        {onRemove && (
          <Button size="icon" variant="ghost" aria-label={`Remove ${draft.name || "this environment"}`} title="Remove environment" onClick={onRemove}>
            <XIcon />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="font-medium text-foreground text-xs">
          Authentication
        </span>
        <div role="radiogroup" aria-label="Authentication" className="inline-flex rounded-lg border bg-background p-0.5 dark:bg-input/32">
          {authOptions.map(({ kind, label }) => (
            <label
              key={kind}
              className="cursor-pointer rounded-md px-2.5 py-1 font-medium text-muted-foreground text-xs outline-ring transition-colors hover:text-foreground has-checked:bg-accent has-checked:text-foreground has-focus-visible:outline-2"
            >
              <input type="radio" name={authName} className="sr-only" checked={draft.auth === kind} onChange={() => onChange({ auth: kind })} />
              {label}
            </label>
          ))}
        </div>
      </div>
      {draft.auth !== "none" && (
        <div className="flex items-end gap-2">
          {draft.auth === "header" && (
            <label className="flex w-36 shrink-0 flex-col gap-1.5 font-medium text-foreground text-xs">
              Header
              <Input spellCheck={false} placeholder="X-API-Key" value={draft.header} onChange={(event) => onChange({ header: event.target.value })} />
            </label>
          )}
          {keeps ? (
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 font-medium text-foreground text-xs">
              {secretLabel}
              <span className="flex h-8 items-center gap-2 rounded-lg border border-input bg-muted/40 ps-3 pe-1 font-normal text-muted-foreground dark:bg-input/16">
                <LockIcon aria-hidden className="size-3.5" />
                Saved
                <Button size="xs" variant="ghost" className="ms-auto" aria-label={`Replace the saved ${secretLabel.toLowerCase()}`} onClick={() => onChange({ replacing: true })}>
                  Replace
                </Button>
              </span>
            </div>
          ) : (
            <label className="flex min-w-0 flex-1 flex-col gap-1.5 font-medium text-foreground text-xs">
              {secretLabel}
              <Input
                type="password"
                autoComplete="off"
                autoFocus={draft.replacing}
                placeholder={draft.auth === "bearer" ? "Paste the token" : "Paste the value"}
                value={draft.secret}
                onChange={(event) => onChange({ secret: event.target.value })}
              />
            </label>
          )}
        </div>
      )}
      {draft.saved && draft.saved.auth.kind !== "none" && !keeps && !draft.replacing && draft.auth !== "none" && (
        <p className="text-muted-foreground text-xs">The host or the authentication changed, so enter the {secretLabel.toLowerCase()} again.</p>
      )}
      {plainHttpToAnotherHost(draft.url, draft.auth) && (
        <p className="flex items-start gap-1.5 text-warning-foreground text-xs">
          <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
          This sends the {draft.auth === "bearer" ? "token" : "header"} over plain http to another computer, where anyone on the way can read it. Use https.
        </p>
      )}
      {problems.map((problem) => (
        <ErrorText key={problem} message={problem} />
      ))}
      <div className="flex min-h-6 items-center gap-2.5">
        <Button size="xs" variant="outline" disabled={!testable || draft.test.busy} onClick={onTest}>
          {draft.test.busy ? <Spinner className="size-3" /> : <PlayIcon />}
          Test
        </Button>
        {result && <TestResult result={result} />}
        <ErrorText message={error} />
      </div>
    </fieldset>
  );
}

// What Test found, in a line: its status, what it measured, and what is wrong.
function TestResult({ result }: { result: ServiceResult }) {
  return (
    <span role="status" className="flex min-w-0 items-center gap-2 text-xs">
      <StatusIcon status={result.status} className="size-3.5" />
      <Badge variant={badgeVariant[result.status]}>{serviceLabel[result.status]}</Badge>
      <span className="shrink-0 text-muted-foreground tabular-nums">{measured(result)}</span>
      {result.problem && <span className="min-w-0 truncate text-foreground" title={result.problem}>{result.problem}</span>}
    </span>
  );
}
