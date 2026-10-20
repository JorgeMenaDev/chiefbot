-- Users live in live. Each schema has its own records, all owned by a live user,
-- so nothing can write records before the caller's user row exists (GET /me makes it).
create table live.users (
  id   text primary key,
  name text not null
);

create table live.records (
  id         bigserial primary key,
  name       text not null unique,
  note       text not null default '',
  created_by text not null references live.users (id)
);

create table sandbox.records (
  id         bigserial primary key,
  name       text not null unique,
  note       text not null default '',
  created_by text not null references live.users (id)
);

create table experimental.records (
  id         bigserial primary key,
  name       text not null unique,
  note       text not null default '',
  created_by text not null references live.users (id)
);
