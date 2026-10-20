import { ChatView, type Bot, type BotId, type ChatItem } from "@chiefbot/contracts";
import { CheckIcon, ChevronRightIcon, CircleAlertIcon, InfoIcon, WrenchIcon, XIcon } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { BotComposerControls } from "./BotComposerControls.tsx";
import { chatRows, type LaneItem, type ToolItem } from "./chatRows.ts";
import { Composer } from "./Composer.tsx";
import { Markdown } from "./Markdown.tsx";
import { Alert, AlertDescription } from "./components/ui/alert.tsx";
import { Empty, EmptyDescription } from "./components/ui/empty.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { bottomFollower } from "./lib/followBottom.ts";
import { cn } from "./lib/utils.ts";

// The bot's chat as Electron main folds it, kept live over chat:state.
function useChat(botId: BotId) {
  const [view, setView] = useState<ChatView>({ botId, items: [], working: null });
  useEffect(() => {
    const unsubscribe = window.chiefbot.chat.onChange((next) => {
      const parsed = ChatView.parse(next);
      if (parsed.botId === botId) setView(parsed);
    });
    void window.chiefbot.chat.open(botId).then((next) => setView(ChatView.parse(next)));
    return unsubscribe;
  }, [botId]);
  return view;
}

// T3 Code's chat shape: a centred lane of messages (user on the right, the bot's
// replies as markdown, tool calls as one-line rows), the bot's status, and the
// composer at the bottom. Enter sends, Shift+Enter adds a line.
export function Chat({ bot }: { bot: Bot }) {
  const view = useChat(bot.id);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const working = view.working !== null;
  // The agent waits while the user has its screen.
  const humanHasScreen = bot.screenControl === "human";
  const canSend = bot.status === "online" && !humanHasScreen && !working && draft.trim() !== "";

  async function submit() {
    if (!canSend) return;
    setError(null);
    try {
      await window.chiefbot.chat.send(bot.id, draft);
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ChatTimeline
        chatKey={bot.id}
        items={view.items}
        status={working ? view.working || "Working" : null}
        empty={`Send ${bot.name} a message to start.`}
        renderItem={(item, streaming) => <Message botId={bot.id} item={item} streaming={streaming} />}
      />
      <Composer
        placeholder={
          bot.status !== "online"
            ? `${bot.name} is ${bot.status}`
            : humanHasScreen
              ? `Hand the screen back to message ${bot.name}`
              : `Message ${bot.name}`
        }
        draft={draft}
        onDraft={setDraft}
        onSend={() => void submit()}
        canSend={canSend}
        error={error}
      >
        <BotComposerControls bot={bot} onError={setError} />
      </Composer>
    </section>
  );
}

function Message({ botId, item, streaming }: { botId: BotId; item: LaneItem; streaming: boolean }) {
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} />;
    case "assistant":
      return <AssistantMessage text={item.text} streaming={streaming} />;
    case "error":
      return <ErrorMessage message={item.message} />;
    case "notice":
      // Control's note about a handoff to a project: needs input, or done.
      return (
        <Alert variant="info">
          <InfoIcon />
          <AlertDescription className="text-foreground">{item.text}</AlertDescription>
        </Alert>
      );
    case "approval":
      return <ApprovalCard item={item} onAnswer={(approved) => window.chiefbot.chat.answer(botId, item.approvalId, approved)} />;
    // A chief's chat has none: it always runs on its owner's seat, as its header says.
    case "payer":
      return null;
  }
}

// The pieces below are shared with a project's coordinator chat (Projects.tsx).

// A chat's message lane. Rows come from chatRows (a turn's tool calls grouped,
// keys that hold while a turn runs); `renderItem` draws every other item, with
// `streaming` true for the reply still arriving. `status` (null when idle) shows
// in a line under the last row that keeps its space while idle, so a turn
// starting or ending moves nothing. `chatKey` names the chat.
export function ChatTimeline({
  chatKey,
  items,
  status,
  empty,
  renderItem,
}: {
  chatKey: string;
  items: readonly ChatItem[];
  status: string | null;
  empty: ReactNode;
  renderItem: (item: LaneItem, streaming: boolean) => ReactNode;
}) {
  const last = items.at(-1);
  const streamingId = status !== null && last?.kind === "assistant" ? last.id : null;
  const lastSent = items.findLast((item) => item.kind === "user")?.id;
  return (
    <Timeline bottomKey={`${chatKey}:${lastSent}`}>
      {items.length === 0 && <ChatEmpty>{empty}</ChatEmpty>}
      {chatRows(items).map((row) =>
        row.kind === "tools" ? (
          <ToolGroup key={row.key} tools={row.tools} folded={row.folded} />
        ) : (
          <Fragment key={row.key}>{renderItem(row.item, row.item.id === streamingId)}</Fragment>
        ),
      )}
      <Working status={status} />
    </Timeline>
  );
}

// The scrolling lane. While the user is at the bottom it stays there
// (lib/followBottom.ts): a ResizeObserver pins it as rows arrive and text
// streams, before the frame paints, so nothing jumps. Scrolled up to read, it
// leaves the view alone. A new `bottomKey` (another chat, or the user's new
// message) goes back to the bottom.
function Timeline({ bottomKey, children }: { bottomKey: string; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  const [follow] = useState(bottomFollower);

  useLayoutEffect(() => {
    if (scroller.current) follow.pin(scroller.current);
  }, [follow, bottomKey]);

  useEffect(() => {
    const element = scroller.current;
    if (!element || !lane.current) return;
    const observer = new ResizeObserver(() => follow.grew(element));
    observer.observe(lane.current);
    observer.observe(element);
    return () => observer.disconnect();
  }, [follow]);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" onScroll={(event) => follow.scrolled(event.currentTarget)}>
      <div ref={lane} className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 px-5 py-6">
        {children}
      </div>
    </div>
  );
}

function ChatEmpty({ children }: { children: ReactNode }) {
  return (
    <Empty>
      <EmptyDescription>{children}</EmptyDescription>
    </Empty>
  );
}

export function UserMessage({ text }: { text: string }) {
  return (
    <div className="max-w-[80%] self-end whitespace-pre-wrap rounded-2xl bg-message p-3 text-message-foreground text-sm leading-relaxed">
      {text}
    </div>
  );
}

export function AssistantMessage({ text, streaming }: { text: string; streaming: boolean }) {
  return <Markdown text={text} streaming={streaming} />;
}

const toolIcon: Record<ToolItem["status"], ReactNode> = {
  running: <Spinner className="size-3" />,
  succeeded: <CheckIcon className="size-3 text-success" aria-label="succeeded" />,
  failed: <XIcon className="size-3 text-destructive" aria-label="failed" />,
};

// A tool call in a line of fixed height, with how it went.
function ToolRow({ name, status }: Pick<ToolItem, "name" | "status">) {
  return (
    <div className="flex h-6 items-center gap-2 font-mono text-muted-foreground text-xs">
      {toolIcon[status]}
      <span className="truncate">{name}</span>
    </div>
  );
}

// A row of tool calls (chatRows.ts). Unfolded: a line per call, so a new call
// only adds a line at the end. Folded: one line that opens the list, naming the
// call running now, or how many ran and failed (after T3 Code's work-group toggle).
function ToolGroup({ tools, folded }: { tools: ToolItem[]; folded: boolean }) {
  const [open, setOpen] = useState(false);
  const list = (
    <div className="flex flex-col">
      {tools.map((tool) => (
        <ToolRow key={tool.id} name={tool.name} status={tool.status} />
      ))}
    </div>
  );
  if (!folded) return list;
  const running = tools.findLast((tool) => tool.status === "running");
  const failed = tools.filter((tool) => tool.status === "failed").length;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="flex h-6 max-w-full cursor-pointer items-center gap-2 text-muted-foreground text-xs transition-colors hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {running ? toolIcon.running : <WrenchIcon className="size-3 shrink-0" />}
        {running ? (
          <span className="truncate font-mono">{running.name}</span>
        ) : (
          <span className="truncate">
            Ran {tools.length} {tools.length === 1 ? "tool" : "tools"}
            {failed > 0 && <span className="text-destructive-foreground">, {failed} failed</span>}
          </span>
        )}
        <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="ps-5">{list}</div>}
    </div>
  );
}

export function ErrorMessage({ message }: { message: string }) {
  return (
    <Alert variant="error">
      <CircleAlertIcon />
      <AlertDescription className="whitespace-pre-wrap">{message}</AlertDescription>
    </Alert>
  );
}

// What the agent is doing now, pulsing, in one line. Idle (null), the line stays empty.
function Working({ status }: { status: string | null }) {
  return (
    <p className="flex h-5 shrink-0 items-center gap-2 text-muted-foreground text-xs">
      {status !== null && (
        <>
          <Spinner className="size-3.5" />
          <span className="animate-working truncate">{status}…</span>
        </>
      )}
    </p>
  );
}
