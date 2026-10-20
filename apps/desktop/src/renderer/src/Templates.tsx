import { Template } from "@chiefbot/contracts";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ErrorText, Muted, Row, Section } from "./Pane.tsx";
import { useAction } from "./Workspaces.tsx";

const TemplateList = z.array(Template);

// The Templates section of Connect apps, under the connections: the template catalog
// control loaded (templates/ in the repo, docs/templates.md), read-only, one row each.
export function Templates() {
  // Null until the list arrives.
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const { run, error } = useAction(async () => setTemplates(TemplateList.parse(await window.chiefbot.templates.list())));

  useEffect(() => {
    void run(async () => {});
  }, []);

  return (
    <Section
      title="Templates"
      description="Stacks of services this Chiefbot ships for projects' engineers, such as an app with its API, gateway and database. A project can run a template's services from its own repos instead of the stand-ins."
    >
      {templates === null && !error && <Muted>Loading…</Muted>}
      {templates?.length === 0 && <Muted>No templates ship with this Chiefbot.</Muted>}
      {templates?.map((template) => <TemplateRow key={template.name} template={template} />)}
      <ErrorText message={error} />
    </Section>
  );
}

// One template: its title and folder name, what it is, the services a project may
// run from a repo, and its setup stages in order with the services each waits for.
export function TemplateRow({ template }: { template: Template }) {
  return (
    <Row
      title={
        <span className="flex items-center gap-2">
          {template.title}
          <span className="font-mono font-normal text-muted-foreground text-xs">{template.name}</span>
        </span>
      }
      meta={template.description}
    >
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
        <dt className="text-muted-foreground">From a repo</dt>
        <dd className="font-mono">{Object.keys(template.services).join(", ")}</dd>
        <dt className="text-muted-foreground">Setup</dt>
        <dd>
          <ol className="flex list-decimal flex-col gap-0.5 ps-4 marker:text-muted-foreground">
            {template.stages.map(({ label, waitsFor }, index) => (
              <li key={index}>
                {label}: <span className="font-mono text-muted-foreground">{waitsFor.join(", ")}</span>
              </li>
            ))}
          </ol>
        </dd>
      </dl>
    </Row>
  );
}
