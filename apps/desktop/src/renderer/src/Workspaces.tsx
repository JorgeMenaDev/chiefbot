import { InviteRequest, Workspace, WorkspaceDetail, WorkspaceInvite, type User } from "@chiefbot/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";

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
function useAction(reload: () => Promise<void>) {
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
    <div className="switcher">
      <button
        className="switcher-button"
        onClick={() => {
          if (!open) void reload();
          setOpen(!open);
        }}
      >
        <span className="bot-name">{current?.name ?? "Personal"}</span>
        {invites.length > 0 && <span className="badge">{invites.length}</span>}
        <span className="muted">▾</span>
      </button>
      {open && (
        <div className="switcher-menu">
          <button className={current === null ? "bot-row selected" : "bot-row"} onClick={() => choose(null)}>
            <span className="bot-name">Personal</span>
          </button>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              className={workspace.id === current?.id ? "bot-row selected" : "bot-row"}
              onClick={() => choose(workspace)}
            >
              <span className="bot-name">{workspace.name}</span>
              <span className="bot-status">{workspace.role}</span>
            </button>
          ))}
          {invites.map((invite) => (
            <div key={invite.id} className="invite-row">
              <span className="muted">
                {invite.invitedBy} invited you to <strong>{invite.workspaceName}</strong>
              </span>
              <button disabled={busy} onClick={() => void accept(invite)}>
                Accept
              </button>
            </div>
          ))}
          <form className="new-bot-form" onSubmit={(event) => void create(event)}>
            <input
              placeholder="+ New workspace"
              value={name}
              maxLength={60}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
            />
          </form>
          {error && <p className="error">{error}</p>}
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
    <div className="bot-pane">
      <header className="bot-header">
        <div>
          <h2>{workspace.name}</h2>
          <p className="muted">Members share this workspace's projects. Personal bots stay with their owner.</p>
        </div>
        {!owner && (
          <div className="actions">
            <button className="danger" disabled={busy} onClick={() => void leave()}>
              Leave
            </button>
          </div>
        )}
      </header>
      <section className="routines">
        {detail?.members.map((member) => (
          <div key={member.userId} className="routine-row">
            <div className="routine-text">
              <strong>
                {member.login}
                {member.userId === user.id && " (you)"}
              </strong>
              <span className="muted">{member.role}</span>
            </div>
            {owner && member.role === "member" && (
              <button className="danger" disabled={busy} onClick={() => void run(() => api.removeMember(workspace.id, member.userId))}>
                Remove
              </button>
            )}
          </div>
        ))}
        {detail?.invites.map((pending) => (
          <div key={pending.id} className="routine-row">
            <div className="routine-text">
              <strong>{pending.login}</strong>
              <span className="muted">invited by {pending.invitedBy}; joins once they sign in and accept</span>
            </div>
            {owner && (
              <button disabled={busy} onClick={() => void run(() => api.revokeInvite(workspace.id, pending.id))}>
                Withdraw
              </button>
            )}
          </div>
        ))}
        {owner && (
          <form className="routine-schedule" onSubmit={(event) => void invite(event)}>
            <input placeholder="GitHub login" value={login} disabled={busy} onChange={(event) => setLogin(event.target.value)} />
            <button type="submit" disabled={busy || !InviteRequest.safeParse({ login }).success}>
              Invite
            </button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}
