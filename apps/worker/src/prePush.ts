// Git's pre-push hook in the bot computer (https://git-scm.com/docs/githooks#_pre_push).
// The image points core.hooksPath at a root-owned directory whose pre-push runs this,
// so every push asks, however the command was spelled. It asks the worker, which
// asks the user in the chat (or lets it through while a push command the user
// approved runs), however long that takes. Exit 1 stops the push.
import { gitSocket, type PrePushRequest } from "./gitSocket.ts";

const [remote = "", url = ""] = process.argv.slice(2);
const updates = (await Bun.stdin.text())
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [localRef = "", , remoteRef = ""] = line.split(" ");
    return { localRef, remoteRef };
  });
const body: PrePushRequest = { remote, url, updates };
// The answer's last line is "approved" or why not; blank lines before it keep the connection alive.
const verdict = await fetch("http://worker/pre-push", { unix: gitSocket(), method: "POST", body: JSON.stringify(body) }).then(
  async (res) => (await res.text()).trim(),
  (error: unknown) => `No answer from the worker (${String(error)}).`,
);
if (verdict !== "approved") {
  console.error(`chiefbot: ${verdict}`);
  process.exit(1);
}
