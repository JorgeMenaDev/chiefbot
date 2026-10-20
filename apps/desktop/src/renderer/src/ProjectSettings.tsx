import { ConfigKey, ProjectSecret, projectFileName, type Project, type ProjectConfig } from "@chiefbot/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { ErrorText, Muted, PaneBody, Row, Section } from "./Pane.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input, Textarea } from "./components/ui/input.tsx";

const SecretList = z.array(ProjectSecret);

// A project's settings view: the config its agents get with where each key comes
// from, the settings members keep in the app (the project file's keys, as YAML)
// and the project's secrets. Any member edits them. `onSaved` runs once new
// settings are saved, so the caller fetches the project again.
export function ProjectSettings({ project, onSaved }: { project: Project; onSaved: () => void }) {
  return (
    <PaneBody>
      <EffectiveConfig project={project} />
      <SettingsEditor project={project} onSaved={onSaved} />
      <Secrets project={project} />
    </PaneBody>
  );
}

// What the header and the config say about the repo's file.
export function fileNote(project: Project) {
  switch (project.file.status) {
    case "found":
      return `From ${projectFileName} and the settings below. A key the settings set wins.`;
    case "missing":
      return "No project file, using app settings.";
    case "invalid":
      return `${projectFileName} has errors, using app settings.`;
  }
}

const notSet = "Not set";
const list = (items: string[]) => (items.length > 0 ? items.join(", ") : "None");
// Each key's value as the config view shows it, in ConfigKey's order.
const shown: Record<ConfigKey, (config: ProjectConfig) => string> = {
  instructions: ({ instructions }) => list(instructions),
  "commands.setup": ({ commands }) => commands.setup ?? notSet,
  "commands.build": ({ commands }) => commands.build ?? notSet,
  "commands.test": ({ commands }) => commands.test ?? notSet,
  "commands.dev": ({ commands }) => commands.dev ?? notSet,
  "commands.devUrl": ({ commands }) => commands.devUrl ?? notSet,
  skills: ({ skills }) => list(skills),
  verify: ({ verify }) => verify ?? notSet,
  connectors: ({ connectors }) => list(connectors),
  mcp: ({ mcp }) => list(Object.entries(mcp).map(([name, { command, args }]) => `${name}: ${[command, ...args].join(" ")}`)),
  secrets: ({ secrets }) => list(secrets),
  "workers.max": ({ workers }) => String(workers.max),
};

function EffectiveConfig({ project }: { project: Project }) {
  return (
    <Section title="Config" description={fileNote(project)}>
      {project.file.status === "invalid" && (
        <p className="whitespace-pre-wrap rounded-lg bg-destructive/8 px-3 py-2 font-mono text-destructive-foreground text-xs dark:bg-destructive/16">
          {project.file.error}
        </p>
      )}
      {ConfigKey.options.map((key) => {
        const source = project.sources[key];
        return (
          <Row
            key={key}
            title={<code className="font-mono text-xs">{key}</code>}
            meta={<span className="break-all font-mono">{shown[key](project.config)}</span>}
            actions={<Badge variant={source === "settings" ? "info" : source === "file" ? "secondary" : "outline"}>{source ?? "default"}</Badge>}
          />
        );
      })}
    </Section>
  );
}

const example = `commands:
  setup: bun install
  test: bun test
secrets: [API_KEY]`;

function SettingsEditor({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [text, setText] = useState(project.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await window.chiefbot.projects.saveSettings(project.id, text);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Settings" description={`The keys of ${projectFileName}, kept in the app for this project. Commands and workers merge key by key; any other key replaces the file's.`}>
      <form className="flex flex-col gap-2 py-2" onSubmit={(event) => void save(event)}>
        <Textarea
          aria-label="Settings"
          className="min-h-36 font-mono text-xs"
          spellCheck={false}
          placeholder={example}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex items-center gap-3">
          <Button size="sm" type="submit" disabled={busy || text === project.settings}>
            Save
          </Button>
          <ErrorText message={error} />
        </div>
      </form>
    </Section>
  );
}

// The secrets the config declares, and values left whose name it no longer
// declares. A value goes to control and never comes back.
function Secrets({ project }: { project: Project }) {
  const api = window.chiefbot.projects;
  const [secrets, setSecrets] = useState<ProjectSecret[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => setSecrets(SecretList.parse(await api.secrets(project.id)));
  useEffect(() => {
    void reload();
  }, [project.id, project.config.secrets.join()]);

  // Runs one change, then reloads; false when control refused it.
  async function act(change: () => Promise<unknown>) {
    setError(null);
    try {
      await change();
      await reload();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  }

  return (
    <Section title="Secrets" description="Values stay in control: nobody can read them back. A worker gets them as environment variables for one job.">
      {secrets.length === 0 && <Muted>No secrets. Name them under secrets: in the settings, then set their values here.</Muted>}
      {secrets.map((secret) => (
        <SecretRow
          key={secret.name}
          secret={secret}
          onSet={(value) => act(() => api.setSecret(project.id, secret.name, value))}
          onClear={() => void act(() => api.clearSecret(project.id, secret.name))}
        />
      ))}
      <ErrorText message={error} />
    </Section>
  );
}

function SecretRow({ secret, onSet, onClear }: { secret: ProjectSecret; onSet: (value: string) => Promise<boolean>; onClear: () => void }) {
  const [value, setValue] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onSet(value)) setValue("");
  }
  return (
    <Row
      title={<code className="font-mono text-xs">{secret.name}</code>}
      meta={!secret.declared ? "No longer declared: clear its value" : secret.set ? "Set" : "Not set"}
      actions={
        <>
          {secret.declared && (
            <form className="flex items-center gap-1.5" onSubmit={(event) => void submit(event)}>
              <Input
                type="password"
                autoComplete="off"
                aria-label={`Value of ${secret.name}`}
                placeholder={secret.set ? "New value" : "Value"}
                className="h-6 w-44 text-xs"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <Button size="xs" variant="outline" type="submit" disabled={value === ""}>
                {secret.set ? "Replace" : "Set"}
              </Button>
            </form>
          )}
          {secret.set && (
            <Button size="xs" variant="ghost" className="text-destructive-foreground" onClick={onClear}>
              Clear
            </Button>
          )}
        </>
      }
    />
  );
}
