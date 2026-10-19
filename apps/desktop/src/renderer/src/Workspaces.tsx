import { CopilotMode, InviteRequest, Workspace, WorkspaceDetail, WorkspaceInvite, type User } from "@chiefbot/contracts";
import { ChevronsUpDownIcon, UsersIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { ErrorText, PaneBody, PaneHeader, Row, Section } from "./Pane.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input, Select } from "./components/ui/input.tsx";
import { SidebarRow } from "./components/ui/sidebar.tsx";

const WorkspaceList = z.array(Workspace);
const InviteList = z.array(WorkspaceInvite);

// The user's workspaces and the invites waiting for their login. Control sends
// no events for these, so `reload` runs on mount, when the switcher opens and
// after every change.
export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const reload = async () => {
    const [list, pending] = await Promise.all([window.chiefbot.workspaces.list(), window.chiefbot.workspaces.invites()]);
    setWorkspaces(WorkspaceList.parse(list));
    setInvites(InviteList.parse(pending));
  };
  useEffect(() => {
    void reload();
  }, []);
  return { workspaces, invites, reload };
}

// Runs one change against control, then `after` (by default the hook's).
// Resolves with the change's value, or null after showing control's refusal.
// Connectors.tsx uses it too.
export function useAction(reload: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async <T,>(change: () => Promise<T>, after = reload): Promise<{ value: T } | null> => {
    setBusy(true);
    setError(null);
    try {
      const value = await change();
      await after();
      return { value };
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

// Top of the sidebar: which workspace is current ("Personal" for none), the
// invites waiting for the user, and a new-workspace form. After T3 Code's
// project picker: one button that opens a menu below it.
export function WorkspaceSwitcher({
  current,
  workspaces,
  invites,
  reload,
  onSelect,
}: ReturnType<typeof useWorkspaces> & { current: Workspace | null; onSelect: (workspace: Workspace | null) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const { run, busy, error } = useAction(reload);
  const choose = (workspace: Workspace | null) => {
    onSelect(workspace);
    setOpen(false);
  };

  async function create(event: FormEvent) {
    event.preventDefault();
    const created = await run(async () => Workspace.parse(await window.chiefbot.workspaces.create(name)));
    if (!created) return;
    setName("");
    choose(created.value);
  }

  async function accept(invite: WorkspaceInvite) {
    const joined = await run(async () => Workspace.parse(await window.chiefbot.workspaces.accept(invite.id)));
    if (joined) choose(joined.value);
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-[var(--control-radius)] border border-sidebar-border px-2 text-left font-medium text-sm transition-colors hover:bg-sidebar-row-hover aria-expanded:bg-sidebar-row-hover"
        onClick={() => {
          if (!open) void reload();
          setOpen(!open);
        }}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary font-semibold text-[11px] text-primary-foreground uppercase">
          {(current?.name ?? "Personal").slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1 truncate">{current?.name ?? "Personal"}</span>
        {invites.length > 0 && <Badge>{invites.length}</Badge>}
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 flex flex-col gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg/10">
          <SidebarRow active={current === null} onClick={() => choose(null)}>
            <span className="min-w-0 flex-1 truncate">Personal</span>
          </SidebarRow>
          {workspaces.map((workspace) => (
            <SidebarRow key={workspace.id} active={workspace.id === current?.id} onClick={() => choose(workspace)}>
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              <span className="shrink-0 font-normal text-muted-foreground text-xs">{workspace.role}</span>
            </SidebarRow>
          ))}
          {invites.map((invite) => (
            <div key={invite.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
              <span className="text-muted-foreground">
                {invite.invitedBy} invited you to <strong className="text-foreground">{invite.workspaceName}</strong>
              </span>
              <Button size="xs" disabled={busy} onClick={() => void accept(invite)}>
                Accept
              </Button>
            </div>
          ))}
          <form className="mt-0.5 border-t pt-1.5" onSubmit={(event) => void create(event)}>
            <Input
              placeholder="+ New workspace"
              value={name}
              maxLength={60}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
            />
          </form>
          <div className="px-1">
            <ErrorText message={error} />
          </div>
        </div>
      )}
    </div>
  );
}

// The members screen: who is in the workspace and who is invited. The owner
// invites by GitHub login, withdraws invites and removes members; a member can
// leave. `onLeft` runs once the user is no longer a member.
export function Members({ workspace, user, onLeft }: { workspace: Workspace; user: User; onLeft: () => void }) {
  const api = window.chiefbot.workspaces;
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [login, setLogin] = useState("");
  const reload = async () => setDetail(WorkspaceDetail.parse(await api.detail(workspace.id)));
  const { run, busy, error } = useAction(reload);
  const owner = workspace.role === "owner";

  useEffect(() => {
    void reload();
  }, [workspace.id]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    if (await run(() => api.invite(workspace.id, login))) setLogin("");
  }

  async function leave() {
    // No reload after: the workspace is gone for the user.
    if (await run(() => api.removeMember(workspace.id, user.id), async () => {})) onLeft();
  }

  return (
    <>
      <PaneHeader icon={<UsersIcon className="size-4 text-muted-foreground" />} title={workspace.name} note="Members">
        {!owner && (
          <Button size="xs" variant="destructive-outline" disabled={busy} onClick={() => void leave()}>
            Leave
          </Button>
        )}
      </PaneHeader>
      <PaneBody>
        <Section title="Members" description="Members share this workspace's projects. Personal bots stay with their owner.">
          {detail?.members.map((member) => (
            <Row
              key={member.userId}
              title={
                <>
                  {member.login}
                  {member.userId === user.id && <span className="font-normal text-muted-foreground"> (you)</span>}
                </>
              }
              meta={member.role}
              actions={
                owner &&
                member.role === "member" && (
                  <Button size="xs" variant="destructive-outline" disabled={busy} onClick={() => void run(() => api.removeMember(workspace.id, member.userId))}>
                    Remove
                  </Button>
                )
              }
            />
          ))}
          {detail?.invites.map((pending) => (
            <Row
              key={pending.id}
              title={pending.login}
              meta={`invited by ${pending.invitedBy}; joins once they sign in and accept`}
              actions={
                owner && (
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(() => api.revokeInvite(workspace.id, pending.id))}>
                    Withdraw
                  </Button>
                )
              }
            />
          ))}
          {owner && (
            <form className="flex gap-2 pt-3" onSubmit={(event) => void invite(event)}>
              <Input placeholder="GitHub login" value={login} disabled={busy} onChange={(event) => setLogin(event.target.value)} />
              <Button type="submit" variant="outline" disabled={busy || !InviteRequest.safeParse({ login }).success}>
                Invite
              </Button>
            </form>
          )}
        </Section>
        {detail && (
          <Section title="Copilot for projects">
            <Row
              title={detail.copilotMode === "personal" ? "Each member's seat" : "The organization"}
              meta={`${copilotModeText[detail.copilotMode]} Chiefs always run on their owner's seat.`}
              actions={
                owner && (
                  <Select
                    value={detail.copilotMode}
                    disabled={busy}
                    onChange={(event) => void run(() => api.setCopilotMode(workspace.id, CopilotMode.parse(event.target.value)))}
                  >
                    <option value="personal">Each member's seat</option>
                    <option value="org">The organization</option>
                  </Select>
                )
              }
            />
          </Section>
        )}
        <ErrorText message={error} />
      </PaneBody>
    </>
  );
}

// What each mode means for the workspace's project agents (coordinators and workers).
const copilotModeText: Record<CopilotMode, string> = {
  personal: "Project agents run on the Copilot seat of the member who asked.",
  org: "Project agents run on the organization's Copilot: Chiefbot's repo app, installed on the project repo's owner, pays.",
};
