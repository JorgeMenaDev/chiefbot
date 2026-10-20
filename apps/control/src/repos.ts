import {
  RepoFullName,
  type ApiErrorCode,
  type ApprovalKind,
  type OpenedPullRequest,
  type PullRequestArgs,
  type UserId,
} from "@chiefbot/contracts";
import type { ApprovalOutcome } from "./approvals.ts";
import { createPullRequest, installationToken, repoPermission, type GitHubAppKey } from "./github.ts";

// Control's repo access, the boundary between bots and GitHub. Control holds the
// only credential that may write (the deployer's repo app, through one-repo
// installation tokens it never hands out; the owner's sign-in token, which their
// bots get for Copilot, has no repository permissions). A bot computer reaches repos through
// control's git proxy with its running turn's key: fetches pass through, and every
// push waits for the owner's approval before control forwards it. Pull requests
// are opened by control, also after approval. Each request first checks that the
// owner is still signed in and, through the repo app, that they may do it themselves.
// A project's task worker reaches repos the same way, with its turn's key: for
// it, the "owner" is the member who asked for it.

// Who a turn key acts for: whose GitHub account bounds its repo access, and
// how to ask that person to approve, in that turn of the bot or task worker.
export type RepoAgent = {
  userId: UserId;
  ask: (kind: ApprovalKind, detail: string, signal: AbortSignal) => Promise<ApprovalOutcome>;
};

export type RepoAccessOptions = {
  // github.com (git) and api.github.com; fakes in tests.
  githubUrl: string;
  githubApiUrl: string;
  app: GitHubAppKey;
  // The bot owner's GitHub login, or null when they must sign in again.
  ownerLogin: (userId: UserId) => Promise<string | null>;
  // The agent whose running turn a key is (a bot's or task worker's), if any.
  agentFor: (key: string) => RepoAgent | null;
};

type Refusal = { error: ApiErrorCode; status: number; message: string };

// What each way an approval can end without a yes tells the bot.
const unapproved = {
  push: {
    declined: "The user declined this push.",
    no_turn: "No turn is running, so nobody can approve this push.",
    ended: "The bot's turn ended before anyone approved this push.",
  },
  "pull-request": {
    declined: "The user declined this pull request.",
    no_turn: "No turn is running, so nobody can approve this pull request.",
    ended: "The bot's turn ended before anyone approved this pull request.",
  },
};

export function repoAccess({ githubUrl, githubApiUrl, app, ownerLogin, agentFor }: RepoAccessOptions) {
  // A token that may `access` the repo: the app's installation token for it,
  // once it shows the bot owner may do it themselves. For a read where the app
  // is not installed the token is null: GitHub is asked without one, which works
  // only for public repos. Or why not. Called again after an approval, for a fresh token.
  async function grant(userId: UserId, fullName: string, access: "read" | "write"): Promise<{ token: string | null } | Refusal> {
    const login = await ownerLogin(userId);
    if (!login) {
      return { error: "reauth_needed", status: 403, message: "Chiefbot has lost your GitHub sign-in. Sign in again in the Chiefbot app." };
    }
    const installation = await installationToken(githubApiUrl, app, fullName, access);
    if (installation === null) return access === "write" ? notInstalled(fullName) : { token: null };
    const permission = await repoPermission(githubApiUrl, installation, fullName, login);
    if (permission === "none") {
      return { error: "repo_not_found", status: 404, message: `${fullName} was not found, or your GitHub account cannot see it.` };
    }
    if (access === "write" && permission !== "write") {
      return { error: "repo_read_only", status: 403, message: `Your GitHub account cannot push to ${fullName}.` };
    }
    return { token: installation };
  }

  return {
    // A token that may read the repo for the user (null: ask GitHub without one,
    // which works only for a public repo the app is not installed on), or why not.
    readToken: (userId: UserId, fullName: string) => grant(userId, fullName, "read"),

    // GET /git/:owner/:repo/info/refs, POST /git/:owner/:repo/git-upload-pack and
    // POST /git/:owner/:repo/git-receive-pack: git's smart HTTP protocol, with the
    // turn's key as the Basic auth password. Errors are text/plain, which git
    // prints as "remote: …".
    async git(req: Request, server: Bun.Server<unknown>, { owner, repo }: { owner: string; repo: string }): Promise<Response> {
      const bot = agentFor(basicPassword(req));
      if (!bot) {
        return new Response("Chiefbot: no turn key, or one whose turn is not running.\n", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="Chiefbot"' },
        });
      }
      const url = new URL(req.url);
      const name = repo.replace(/\.git$/, "");
      const fullName = `${owner}/${name}`;
      if (!RepoFullName.safeParse(fullName).success) return text(404, `${fullName} is not a GitHub repository name.`);
      const service = url.pathname.endsWith("/info/refs") ? url.searchParams.get("service") : url.pathname.split("/").at(-1);
      if (service !== "git-upload-pack" && service !== "git-receive-pack") {
        return text(403, "Chiefbot's git proxy speaks only git's smart HTTP protocol.");
      }
      const push = service === "git-receive-pack";
      const access = await grant(bot.userId, fullName, push ? "write" : "read");
      if ("error" in access) return text(access.status, access.message);
      const body = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : undefined;

      let token = access.token;
      // Every push that may update a ref waits for the owner, however long that
      // takes, and control forwards exactly the bytes they approved. Only git's
      // probe before a large push (a bare flush packet) updates nothing and passes.
      if (push && body && !isProbe(body)) {
        const request = pushRequest(body, req.headers.get("content-encoding"));
        if (request === null) return text(415, "Chiefbot's git proxy reads only plain or gzip push requests.");
        server.timeout(req, 0);
        const outcome = await bot.ask("push", `git push to ${fullName}: ${branchList(request.refs)}`, req.signal);
        if (outcome !== "approved") return rejectPush(request, unapproved.push[outcome]);
        const fresh = await grant(bot.userId, fullName, "write");
        if ("error" in fresh) return rejectPush(request, fresh.message);
        token = fresh.token;
      }

      const headers = new Headers();
      for (const name of ["content-type", "accept", "content-encoding", "git-protocol"]) {
        const value = req.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      if (token) headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
      const rest = url.pathname.slice(`/git/${owner}/${repo}`.length);
      const res = await fetch(`${githubUrl}/${fullName}.git${rest}${url.search}`, { method: req.method, headers, body, timeout: false });
      // Without an installation token GitHub sees an anonymous request, which only a public repo answers.
      if (!token && (res.status === 401 || res.status === 404)) return text(403, notInstalled(fullName).message);
      // Only what git reads: GitHub's auth challenge must not reach git, and the body is already decoded.
      const forwarded = new Headers();
      for (const name of ["content-type", "cache-control"]) {
        const value = res.headers.get(name);
        if (value !== null) forwarded.set(name, value);
      }
      return new Response(res.body, { status: res.status, headers: forwarded });
    },

    // The create_pull_request tool (POST /worker/:botId/pull-requests, or a task worker's):
    // asks the owner, then opens the pull request with the app's installation token.
    // An engineer's opens as a draft (`draft`).
    async pullRequest(
      bot: RepoAgent,
      args: PullRequestArgs,
      signal: AbortSignal,
      { draft = false }: { draft?: boolean } = {},
    ): Promise<OpenedPullRequest | Refusal> {
      const access = await grant(bot.userId, args.repository, "write");
      if ("error" in access) return access;
      const outcome = await bot.ask("pull-request", `${args.repository}: ${args.head} → ${args.base}${draft ? " (draft)" : ""}\n${args.title}`, signal);
      if (outcome !== "approved") {
        return { error: outcome === "declined" ? "declined" : "no_turn", status: outcome === "declined" ? 403 : 409, message: unapproved["pull-request"][outcome] };
      }
      const fresh = await grant(bot.userId, args.repository, "write");
      if ("error" in fresh) return fresh;
      // grant only returns a null token for reads.
      const opened = await createPullRequest(githubApiUrl, fresh.token ?? "", args, draft);
      return "refused" in opened ? { error: "github_failed", status: 502, message: opened.refused } : opened;
    },
  };
}

function notInstalled(fullName: string): Refusal {
  return {
    error: "app_not_installed",
    status: 403,
    message: `Install your Chiefbot repo app on ${fullName}: control reaches only the repositories it is installed on.`,
  };
}

function text(status: number, message: string) {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function basicPassword(req: Request) {
  const basic = req.headers.get("authorization")?.match(/^Basic (.+)$/)?.[1];
  return basic ? atob(basic).split(":").slice(1).join(":") : "";
}

const isProbe = (body: Uint8Array) => body.length === 4 && new TextDecoder().decode(body) === "0000";

// A receive-pack request's commands, read from its pkt-lines ("<old> <new> <ref>",
// the first with the client's capabilities after a NUL) up to the flush packet
// (https://git-scm.com/docs/pack-protocol#_reference_update_request_and_packfile_transfer).
// Null for a content encoding control cannot read.
type PushRequest = { refs: Array<{ ref: string; deleted: boolean }>; capabilities: string[] };
function pushRequest(raw: Uint8Array<ArrayBuffer>, encoding: string | null): PushRequest | null {
  if (encoding !== null && encoding !== "gzip") return null;
  const body = encoding === "gzip" ? Bun.gunzipSync(raw) : raw;
  const latin1 = new TextDecoder("latin1");
  const request: PushRequest = { refs: [], capabilities: [] };
  let at = 0;
  while (at + 4 <= body.length) {
    const length = Number.parseInt(latin1.decode(body.subarray(at, at + 4)), 16);
    if (!(length > 4)) break;
    const [command = "", capabilities] = latin1.decode(body.subarray(at + 4, at + length)).split("\0");
    if (capabilities !== undefined) request.capabilities = capabilities.trim().split(" ");
    const [, newId = "", ref = ""] = command.trim().split(" ");
    if (ref) request.refs.push({ ref, deleted: /^0+$/.test(newId) });
    at += length;
  }
  return request;
}

// The approval card's list: "main, old (delete)".
const branchList = (refs: PushRequest["refs"]) =>
  refs.map(({ ref, deleted }) => ref.replace(/^refs\/heads\//, "") + (deleted ? " (delete)" : "")).join(", ");

// The answer GitHub would give a push it refuses, so git shows `message`: each
// ref "! [remote rejected] … (message)", and "remote: message" when the client
// takes side-band messages. Git ignores the body of a failed push request.
function rejectPush({ refs, capabilities }: PushRequest, message: string) {
  const pkt = (line: string) => (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0") + line;
  const report = pkt("unpack ok\n") + refs.map(({ ref }) => pkt(`ng ${ref} ${message}\n`)).join("") + "0000";
  const sideBand = capabilities.includes("side-band-64k") || capabilities.includes("side-band");
  const body = sideBand ? pkt(`\x02${message}\n`) + pkt(`\x01${report}`) + "0000" : report;
  return new Response(body, { headers: { "content-type": "application/x-git-receive-pack-result" } });
}
