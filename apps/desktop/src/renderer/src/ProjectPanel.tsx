import { ProjectTasks, ProjectWorkers, Task, TaskWorker, type Project, type ProjectId, type TaskWorkerId } from "@chiefbot/contracts";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Engineers } from "./Engineers.tsx";
import { PanelToggle, SidePanel } from "./Pane.tsx";
import { ProjectContext } from "./ProjectContext.tsx";
import { TaskLedger } from "./ProjectTasks.tsx";
import { TabPanel, Tabs, useTabIds, type TabItem } from "./components/ui/tabs.tsx";

const TaskList = z.array(Task);
const WorkerList = z.array(TaskWorker);

// The project's task ledger and its engineers: fetched once, then kept live by
// the ledgers and engineer lists control sends on /events.
function useProjectWork(projectId: ProjectId) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workers, setWorkers] = useState<TaskWorker[]>([]);
  useEffect(() => {
    const unsubscribeTasks = window.chiefbot.projects.onTasks((next) => {
      const ledger = ProjectTasks.parse(next);
      if (ledger.projectId === projectId) setTasks(ledger.tasks);
    });
    const unsubscribeWorkers = window.chiefbot.projects.onWorkers((next) => {
      const list = ProjectWorkers.parse(next);
      if (list.projectId === projectId) setWorkers(list.workers);
    });
    void window.chiefbot.projects.tasks(projectId).then((next) => setTasks(TaskList.parse(next)));
    void window.chiefbot.projects.workers(projectId).then((next) => setWorkers(WorkerList.parse(next)));
    return () => {
      unsubscribeTasks();
      unsubscribeWorkers();
    };
  }, [projectId]);
  return { tasks, workers };
}

type PanelTab = "tasks" | "engineers" | "context";

// The work panel right of a project's conversation, in three tabs: Tasks (the
// ledger, with what each engineer waits on), Engineers (each engineer's screen
// and transcript) and Context (the shared notes). Open on a task's engineer
// switches to Engineers with that engineer open. Closed (`hidden`), it stays
// mounted, so an engineer's screen stays connected.
export function ProjectPanel({ project, login, hidden, onClose }: { project: Project; login: string; hidden: boolean; onClose: () => void }) {
  const { tasks, workers } = useProjectWork(project.id);
  const [tab, setTab] = useState<PanelTab>("tasks");
  const [watching, setWatching] = useState<TaskWorkerId | null>(null);
  const ids = useTabIds<PanelTab>();
  const open = tasks.filter(({ status }) => status !== "done" && status !== "abandoned").length;
  const running = workers.filter(({ state }) => state === "launching" || state === "working").length;
  const tabs: Array<TabItem<PanelTab>> = [
    { key: "tasks", label: "Tasks", note: <Count value={open} />, title: `${open} open` },
    { key: "engineers", label: "Engineers", note: <Count value={running} />, title: `${running} running` },
    { key: "context", label: "Context", title: "Shared notes" },
  ];
  return (
    <SidePanel
      hidden={hidden}
      bar={
        <>
          <Tabs label={`${project.name} work`} tabs={tabs} value={tab} ids={ids} onChange={setTab} className="min-w-0 flex-1" />
          <PanelToggle open label="Project panel" onClick={onClose} />
        </>
      }
    >
      <TabPanel ids={ids} tab="tasks" value={tab}>
        <TaskLedger
          project={project}
          login={login}
          tasks={tasks}
          workers={workers}
          onWatch={(workerId) => {
            setWatching(workerId);
            setTab("engineers");
          }}
        />
      </TabPanel>
      <TabPanel ids={ids} tab="engineers" value={tab} className="flex min-h-0 flex-1 flex-col">
        <Engineers project={project} login={login} tasks={tasks} workers={workers} selected={watching} onSelect={setWatching} />
      </TabPanel>
      <TabPanel ids={ids} tab="context" value={tab}>
        {tab === "context" && <ProjectContext project={project} />}
      </TabPanel>
    </SidePanel>
  );
}

// A tab's count, quiet beside its label; none at zero.
function Count({ value }: { value: number }) {
  return value > 0 && <span className="text-muted-foreground text-xs tabular-nums">{value}</span>;
}
