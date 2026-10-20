import { ChatView, type Bot, type BotId, type ChatItem } from "@chiefbot/contracts";
import { CheckIcon, CircleAlertIcon, InfoIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { BotComposerControls } from "./BotComposerControls.tsx";
import { Composer } from "./Composer.tsx";
import { Alert, AlertDescription } from "./components/ui/alert.tsx";
import { Empty, EmptyDescription } from "./components/ui/empty.tsx";
import { Spinner } from "./components/ui/spinner.tsx";

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
// replies as plain text, tool calls as one-line rows), the bot's status, and the
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
      <Timeline follow={view}>
        {view.items.length === 0 && <ChatEmpty>Send {bot.name} a message to start.</ChatEmpty>}
        {view.items.map((item) => (
          <Message key={item.id} botId={bot.id} item={item} />
        ))}
        {working && <Working>{view.working || "Working"}</Working>}
      </Timeline>
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

function Message({ botId, item }: { botId: BotId; item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} />;
    case "assistant":
      return <AssistantMessage text={item.text} />;
    case "tool":
      return <ToolRow name={item.name} status={item.status} />;
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

// The scrolling message lane. It follows the newest message whenever `follow` changes.
export function Timeline({ follow, children }: { follow: unknown; children: ReactNode }) {
  const end = useRef<HTMLDivElement>(null);
  // A block body on purpose: Chromium's scrollIntoView returns a promise, and an
  // effect must return nothing or a cleanup function.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [follow]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 px-5 py-6">
        {children}
        <div ref={end} />
      </div>
    </div>
  );
}

export function ChatEmpty({ children }: { children: ReactNode }) {
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

export function AssistantMessage({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap text-foreground text-sm leading-relaxed">{text}</div>;
}

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const toolIcon: Record<ToolItem["status"], ReactNode> = {
  running: <Spinner className="size-3" />,
  succeeded: <CheckIcon className="size-3 text-success" aria-label="succeeded" />,
  failed: <XIcon className="size-3 text-destructive" aria-label="failed" />,
};

// A tool call in a line, with how it went.
export function ToolRow({ name, status }: Pick<ToolItem, "name" | "status">) {
  return (
    <div className="flex items-center gap-2 font-mono text-muted-foreground text-xs">
      {toolIcon[status]}
      <span className="truncate">{name}</span>
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

// What the agent is doing now, pulsing.
export function Working({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-muted-foreground text-xs">
      <Spinner className="size-3.5" />
      <span className="animate-working">{children}…</span>
    </p>
  );
}
