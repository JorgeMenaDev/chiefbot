// A git credential helper (https://git-scm.com/docs/gitcredentials) for the bot
// computer, for control's git proxy only (gitProxy.ts sets it up for control's
// URL). On `get` it asks the worker, over a unix socket, for the bot's
// credential, which control's proxy accepts for repos the bot's owner may use.
// It is not a GitHub token: pushes through it still wait for the owner's
// approval in control. Nothing is stored: `store` and `erase` do nothing.
import { gitSocket } from "./gitProxy.ts";

if (process.argv.at(-1) === "get") {
  await Bun.stdin.text();
  const res = await fetch("http://worker/git-credential", { unix: gitSocket() }).catch((error: unknown) => error);
  if (!(res instanceof Response) || !res.ok) {
    console.error(`chiefbot: no bot credential from the worker (${res instanceof Response ? await res.text() : String(res)})`);
    process.exit(1);
  }
  process.stdout.write(await res.text());
}
