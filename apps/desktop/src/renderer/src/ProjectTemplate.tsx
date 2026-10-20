import { Template, type Project, type ProjectConfig, type ServiceSource } from "@chiefbot/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { isMap, parseDocument, YAMLMap } from "yaml";
import { z } from "zod";
import { ErrorText, Muted, Row, Section } from "./Pane.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input, Select } from "./components/ui/input.tsx";

const TemplateList = z.array(Template);

// A project's template keys, as the picker edits them (docs/templates.md).
export type TemplateChoice = Pick<ProjectConfig, "template" | "service" | "services">;

// The settings' YAML `text` with the picker's choice in it: `template`, `service`
// and `services` set (or, with no template, taken out), every other key and comment
// kept. Text that is not YAML is refused: it has no key to set.
export function withTemplate(text: string, { template, service, services }: TemplateChoice): string | { error: string } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { error: "Fix the YAML under Settings first, then pick a template." };
  if (template === undefined) {
    if (!isMap(doc.contents)) return text;
    for (const key of ["template", "service", "services"]) doc.delete(key);
    return doc.contents.items.length === 0 ? "" : String(doc);
  }
  doc.set("template", template);
  if (service === undefined) doc.delete("service");
  else doc.set("service", service);
  // One line a service: `api: { repo: octo-org/api, ref: main }` or `gateway: stand-in`.
  const map = new YAMLMap();
  for (const [name, source] of Object.entries(services)) map.set(name, source === "stand-in" ? source : doc.createNode(source, { flow: true }));
  doc.set("services", map);
  return String(doc);
}

// Every service of the template but the project's own, in the template's order,
// each where `current` runs it, else on its stand-in.
const everyService = (template: Template, own: string | undefined, current: TemplateChoice["services"]) =>
  Object.fromEntries(Object.keys(template.services).flatMap((name) => (name === own ? [] : [[name, current[name] ?? "stand-in"]])));

// The Template section of a project's settings: it loads the catalog, then shows TemplateForm.
export function ProjectTemplate({ project, onSaved }: { project: Project; onSaved: () => void }) {
  // Null until the catalog arrives.
  const [catalog, setCatalog] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    window.chiefbot.templates.list().then(
      (list) => setCatalog(TemplateList.parse(list)),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, []);
  if (catalog === null) {
    return (
      <Section title="Template">
        {!error && <Muted>Loading…</Muted>}
        <ErrorText message={error} />
      </Section>
    );
  }
  // A new form once settings are saved, from either editor, so it starts from them.
  return <TemplateForm key={project.settings} project={project} catalog={catalog} onSaved={onSaved} />;
}

// The template the project's engineers get, from the catalog (`catalog`), which of its
// services the project's repo is, and where each other service runs from: a repo
// at a branch or tag, or its stand-in. It starts from the config and saves the
// choice into the settings (withTemplate), where control checks it.
export function TemplateForm({ project, catalog, onSaved }: { project: Project; catalog: Template[]; onSaved: () => void }) {
  const { template, service, services } = project.config;
  const [choice, setChoice] = useState<TemplateChoice>({ template, service, services });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = catalog.find(({ name }) => name === choice.template);
  const source = project.sources.template;

  function pick(name: string) {
    const next = catalog.find((entry) => entry.name === name);
    if (!next) return setChoice({ template: undefined, service: undefined, services: {} });
    const own = choice.service !== undefined && Object.hasOwn(next.services, choice.service) ? choice.service : undefined;
    setChoice({ template: next.name, service: own, services: everyService(next, own, choice.services) });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const text = withTemplate(project.settings, picked ? { ...choice, services: everyService(picked, choice.service, choice.services) } : choice);
    if (typeof text !== "string") return setError(text.error);
    setBusy(true);
    try {
      await window.chiefbot.projects.saveSettings(project.id, text);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const unchanged = JSON.stringify(choice) === JSON.stringify({ template, service, services });
  return (
    <Section
      title="Template"
      description="A stack of services each engineer gets beside its code, such as an API, a gateway and a database. Saving writes template, service and services into the settings, over the file's."
    >
      <form className="flex flex-col py-2" onSubmit={(event) => void save(event)}>
        <Row
          title="Template"
          meta={picked?.description ?? "Engineers get the repo alone."}
          actions={
            <>
              {source && <Badge variant={source === "settings" ? "info" : "secondary"}>{source}</Badge>}
              <Select aria-label="Template" value={choice.template ?? ""} disabled={busy} onChange={(event) => pick(event.target.value)}>
                <option value="">None</option>
                {catalog.map(({ name, title }) => (
                  <option key={name} value={name}>
                    {title}
                  </option>
                ))}
              </Select>
            </>
          }
        />
        {picked && (
          <Row
            title="This repo"
            meta={`The service ${project.repo} is. It runs from each engineer's own clone, so its edits show live.`}
            actions={
              <Select
                aria-label="This repo's service"
                value={choice.service ?? ""}
                disabled={busy}
                onChange={(event) => {
                  const own = event.target.value;
                  setChoice({ ...choice, service: own, services: everyService(picked, own, choice.services) });
                }}
              >
                {choice.service === undefined && <option value="">Pick one</option>}
                {Object.keys(picked.services).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            }
          />
        )}
        {picked &&
          Object.entries(picked.services).map(([name, { context }]) =>
            name === choice.service ? (
              <Row
                key={name}
                title={
                  <span className="flex items-center gap-2">
                    <code className="font-mono text-xs">{name}</code>
                    <Badge variant="info">This repo</Badge>
                  </span>
                }
                meta={`Runs from ${project.repo}, in each engineer's own clone.`}
              />
            ) : (
              <ServiceRow
                key={name}
                name={name}
                context={context}
                source={choice.services[name] ?? "stand-in"}
                disabled={busy}
                onChange={(next) => setChoice({ ...choice, services: { ...choice.services, [name]: next } })}
              />
            ),
          )}
        <div className="flex items-center gap-3 pt-2">
          <Button size="sm" type="submit" disabled={busy || unchanged || (picked !== undefined && choice.service === undefined)}>
            Save
          </Button>
          <ErrorText message={error} />
        </div>
      </form>
    </Section>
  );
}

// One service besides the project's own: its stand-in, or a repo at a branch or tag,
// whose image builds from the service's `context` folder in it.
function ServiceRow({
  name,
  context,
  source,
  disabled,
  onChange,
}: {
  name: string;
  context: string;
  source: ServiceSource;
  disabled: boolean;
  onChange: (source: ServiceSource) => void;
}) {
  return (
    <Row
      title={<code className="font-mono text-xs">{name}</code>}
      meta={source === "stand-in" ? "Runs the template's stand-in." : `Builds from ${context === "." ? "the root" : context} of the repo, at the branch or tag.`}
      actions={
        <>
          {source !== "stand-in" && (
            <>
              <Input
                aria-label={`Repo of ${name}`}
                placeholder="owner/repo"
                className="h-6 w-40 text-xs"
                value={source.repo}
                disabled={disabled}
                onChange={(event) => onChange({ ...source, repo: event.target.value })}
              />
              <Input
                aria-label={`Branch or tag of ${name}`}
                placeholder="main"
                className="h-6 w-24 text-xs"
                value={source.ref}
                disabled={disabled}
                onChange={(event) => onChange({ ...source, ref: event.target.value })}
              />
            </>
          )}
          <Select
            aria-label={`Source of ${name}`}
            value={source === "stand-in" ? "stand-in" : "repo"}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value === "stand-in" ? "stand-in" : { repo: "", ref: "main" })}
          >
            <option value="stand-in">Stand-in</option>
            <option value="repo">A repo</option>
          </Select>
        </>
      }
    />
  );
}
