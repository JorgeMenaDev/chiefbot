import { ContextFile, ContextFileText, ContextImagePath, type ContextPath, type Project } from "@chiefbot/contracts";
import { ChevronLeftIcon, FileTextIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ago } from "./healthStatus.tsx";
import { Markdown } from "./Markdown.tsx";
import { ErrorText } from "./Pane.tsx";
import { Button } from "./components/ui/button.tsx";

const FileList = z.array(ContextFile);

// The Context tab of a project's panel: the shared notes its project agent,
// engineers and verifiers keep, read-only. The list is fetched each time the
// tab opens, as control sends no context events; a file opens as Markdown
// (`open`, kept by the panel, so a task's verification report can open here).
export function ProjectContext({ project, open, onOpen }: { project: Project; open: ContextPath | null; onOpen: (path: ContextPath | null) => void }) {
  const [files, setFiles] = useState<ContextFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    window.chiefbot.projects
      .context(project.id)
      .then((next) => setFiles(FileList.parse(next)))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [project.id]);

  if (open) return <ContextFileView project={project} path={open} onBack={() => onOpen(null)} />;
  return (
    <div className="flex flex-col gap-0.5 p-2">
      <ErrorText message={error} />
      {files?.length === 0 && <p className="px-3 py-6 text-center text-muted-foreground text-xs">No shared notes yet. {project.name} and its engineers write plans and findings here.</p>}
      {files
        ?.toSorted((a, b) => b.updatedAt - a.updatedAt)
        .map(({ path, size, updatedAt }) => (
          <button
            key={path}
            type="button"
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm transition-colors hover:bg-accent"
            onClick={() => onOpen(path)}
          >
            <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
            <span className="shrink-0 text-muted-foreground text-xs" title={new Date(updatedAt).toLocaleString()}>
              {(size / 1024).toFixed(1)} KB · {ago(updatedAt, Date.now())}
            </span>
          </button>
        ))}
    </div>
  );
}

// One context file's Markdown, with the way back to the list. Its images are
// the context's PNGs beside it (a verification report's screenshots).
function ContextFileView({ project, path, onBack }: { project: Project; path: ContextPath; onBack: () => void }) {
  const [file, setFile] = useState<ContextFileText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const image = useCallback((src: string, alt: string) => <ContextImage project={project} path={imagePathIn(path, src)} alt={alt} />, [project, path]);
  useEffect(() => {
    window.chiefbot.projects
      .contextFile(project.id, path)
      .then((next) => setFile(ContextFileText.parse(next)))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [project.id, path]);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <Button size="icon-xs" variant="ghost" aria-label="Back to context" title="Back to context" onClick={onBack}>
          <ChevronLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
      </div>
      <div className="px-5 py-4">
        <ErrorText message={error} />
        {file && <Markdown text={file.content} image={image} />}
      </div>
    </div>
  );
}

// The context image a file at `from` links as `src`: a PNG in the file's folder
// or below it, else null (one outside the context, or on the web).
export function imagePathIn(from: ContextPath, src: string): ContextImagePath | null {
  const path = ContextImagePath.safeParse(from.slice(0, from.lastIndexOf("/") + 1) + src);
  return path.success ? path.data : null;
}

// One of the context's images, loaded through main; its alt text until then, or when there is none.
function ContextImage({ project, path, alt }: { project: Project; path: ContextImagePath | null; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (path === null) return;
    window.chiefbot.projects
      .contextImage(project.id, path)
      .then(setUrl)
      .catch(() => setUrl(null));
  }, [project.id, path]);
  return url ? <img src={url} alt={alt} className="my-2 max-w-full rounded-lg border" /> : <span className="text-muted-foreground">{alt}</span>;
}
