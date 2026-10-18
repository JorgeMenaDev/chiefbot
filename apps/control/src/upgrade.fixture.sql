-- A control database as the first v0.2 build (before its review fixes) left it:
-- that build's schema, as openStore created it, and a few rows it wrote.
-- upgrade.test.ts opens it with today's openStore.
CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    approved INTEGER
  );
CREATE TABLE bots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    running INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  , model TEXT NOT NULL DEFAULT 'auto');
CREATE TABLE chat_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    event TEXT NOT NULL
  );
CREATE TABLE connector_calls (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    connector TEXT NOT NULL,
    tool TEXT NOT NULL,
    requester TEXT NOT NULL,
    identity TEXT NOT NULL,
    run TEXT NOT NULL,
    at INTEGER NOT NULL
  );
CREATE TABLE connector_links (
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    via TEXT NOT NULL CHECK (via IN ('oauth', 'token')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, name, user_id),
    FOREIGN KEY (workspace_id, name) REFERENCES connectors (workspace_id, name) ON DELETE CASCADE
  );
CREATE TABLE connectors (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    server TEXT NOT NULL,
    auth TEXT NOT NULL CHECK (auth IN ('none', 'workspace-secret', 'personal-oauth')),
    scope TEXT NOT NULL,
    has_secret INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, name)
  );
CREATE TABLE coordinator_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES coordinator_turns(id) ON DELETE CASCADE,
    event TEXT NOT NULL
  );
CREATE TABLE coordinator_turns (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done')),
    next_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
CREATE TABLE github_access (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    access_token_expires_at INTEGER NOT NULL,
    refresh_token_expires_at INTEGER NOT NULL
  );
CREATE TABLE handoffs (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    task_number INTEGER NOT NULL,
    request TEXT NOT NULL,
    acceptance TEXT NOT NULL,
    watched_status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (project_id, task_number) REFERENCES project_tasks (project_id, number) ON DELETE CASCADE
  );
CREATE TABLE project_tasks (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'needs_input', 'done', 'abandoned')),
    owner TEXT,
    requested_by TEXT NOT NULL,
    links TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, number)
  );
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    repo TEXT NOT NULL COLLATE NOCASE,
    file TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, repo)
  );
CREATE TABLE routine_runs (
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    turn_id TEXT,
    error TEXT,
    started_computer INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (routine_id, due_at)
  );
CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    next_due_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
CREATE TABLE subscription_events (
    subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    task_number INTEGER,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (subscription_id, event_id)
  );
CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    next_due_at INTEGER NOT NULL,
    baselined INTEGER NOT NULL DEFAULT 0,
    last_polled_at INTEGER,
    last_error TEXT,
    identity TEXT,
    created_at INTEGER NOT NULL
  );
CREATE TABLE task_worker_approvals (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES task_workers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    approved INTEGER
  );
CREATE TABLE task_worker_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT NOT NULL REFERENCES task_workers(id) ON DELETE CASCADE,
    event TEXT NOT NULL
  );
CREATE TABLE task_workers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_number INTEGER NOT NULL,
    creation_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL UNIQUE,
    prompt TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('launching', 'working', 'finished', 'failed', 'stopped')),
    computer TEXT NOT NULL CHECK (computer IN ('wanted', 'unwanted', 'removed')),
    result TEXT,
    pull_request TEXT,
    payer TEXT,
    next_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (project_id, creation_id),
    FOREIGN KEY (project_id, task_number) REFERENCES project_tasks (project_id, number) ON DELETE CASCADE
  );
CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    done INTEGER NOT NULL,
    next_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    github_id INTEGER NOT NULL UNIQUE,
    login TEXT NOT NULL,
    copilot_plan TEXT
  , copilot_models TEXT);
CREATE TABLE workspace_invites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    login TEXT NOT NULL COLLATE NOCASE,
    invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, login)
  );
CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  , copilot_mode TEXT NOT NULL DEFAULT 'personal');
CREATE INDEX chat_events_by_bot ON chat_events (bot_id, seq);
CREATE INDEX coordinator_events_by_chat ON coordinator_events (project_id, user_id, seq);
CREATE INDEX task_worker_events_by_worker ON task_worker_events (worker_id, seq);
INSERT INTO users (id, github_id, login, copilot_plan) VALUES ('user_1', 4242, 'octo-user', 'individual');
INSERT INTO workspaces (id, name, created_at) VALUES ('workspace_1', 'Platform team', 1);
INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES ('workspace_1', 'user_1', 'owner', 1);
INSERT INTO projects (id, workspace_id, name, repo, file, token_hash, created_at)
  VALUES ('project_1', 'workspace_1', 'shop', 'octo-org/shop', '{"connectors":["tracker"],"environments":[],"commands":{}}', 'project-hash', 1);
INSERT INTO connectors (workspace_id, name, title, server, auth, scope, created_at)
  VALUES ('workspace_1', 'tracker', 'Tracker', '{"kind":"remote","url":"https://mcp.example.com/mcp"}', 'personal-oauth', '', 1);
INSERT INTO project_tasks (project_id, number, title, detail, status, owner, requested_by, links, created_at, updated_at)
  VALUES ('project_1', 1, 'Fix the typo', '', 'in_progress', 'worker', 'octo-user', '[]', 1, 1);
INSERT INTO task_workers (id, project_id, task_number, creation_id, user_id, turn_id, prompt, token_hash, state, computer, created_at, updated_at)
  VALUES ('worker_1', 'project_1', 1, 'creation_1', 'user_1', 'turn_1', 'Fix the typo', 'worker-hash', 'working', 'wanted', 1, 1);
INSERT INTO task_worker_approvals (id, worker_id, kind, detail) VALUES ('approval_1', 'worker_1', 'tool', 'git push');
