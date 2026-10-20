import type { ChatItem } from "@chiefbot/contracts";

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;
// Every chat item but a tool call, which shows inside a `tools` row.
export type LaneItem = Exclude<ChatItem, ToolItem>;
type ToolsRow = { kind: "tools"; key: string; tools: ToolItem[]; folded: boolean };

// One row of a chat lane. A row keeps its key while the turn runs, so React
// never remounts it:
//   item   a message, approval, error or note, keyed by its item id
//   tools  tool calls of one turn, keyed by the first call's id. Until the turn
//          has text, a row holds calls made back to back (an approval or a
//          message between them starts a new row), one line each. Once the turn
//          has text it is `folded`: its first tools row holds every call of the
//          turn as one line, after T3 Code's "Worked for…" fold, and the others go.
export type ChatRow = { kind: "item"; key: string; item: LaneItem } | ToolsRow;

// The lane's rows, turn by turn. A turn runs from one user message, or one
// notice (control's note, or a turn control started), to the next.
export function chatRows(items: readonly ChatItem[]): ChatRow[] {
  const rows: ChatRow[] = [];
  let start = 0;
  for (let end = 1; end <= items.length; end++) {
    if (end < items.length && items[end]?.kind !== "user" && items[end]?.kind !== "notice") continue;
    rows.push(...turnRows(items.slice(start, end)));
    start = end;
  }
  return rows;
}

function turnRows(turn: readonly ChatItem[]): ChatRow[] {
  const folded = turn.some((item) => item.kind === "assistant" && item.text.trim() !== "");
  const rows: ChatRow[] = [];
  let first: ToolsRow | undefined;
  let latest: ToolsRow | undefined;
  for (const item of turn) {
    if (item.kind !== "tool") {
      rows.push({ kind: "item", key: item.id, item });
      latest = undefined;
      continue;
    }
    const join = folded ? first : latest;
    if (join) {
      join.tools.push(item);
      continue;
    }
    latest = { kind: "tools", key: item.id, tools: [item], folded };
    first ??= latest;
    rows.push(latest);
  }
  return rows;
}
