// A git credential helper (https://git-scm.com/docs/gitcredentials) for the bot
// computer. On `get` it asks the worker, over a unix socket, for the owner's
// short-lived GitHub token from control's broker and hands it to git. Nothing is
// stored: `store` and `erase` do nothing. The image sets it up for github.com:
//   git config --system credential.https://github.com.helper '!bun /opt/chiefbot/git-credential.js'
import { gitSocket } from "./gitSocket.ts";

if (process.argv.at(-1) === "get") {
  await Bun.stdin.text();
  const res = await fetch("http://worker/git-credential", { unix: gitSocket() }).catch((error: unknown) => error);
  if (!(res instanceof Response) || !res.ok) {
    console.error(`chiefbot: no GitHub token from the worker (${res instanceof Response ? await res.text() : String(res)})`);
    process.exit(1);
  }
  process.stdout.write(await res.text());
}
