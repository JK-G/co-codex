// Walks a finished Codex turn, its subagent threads included, and reads what happened in it:
// the items for images (lib/images.mjs) and the actions Codex was refused for lack of approval.

const SLACK_S = 5; // clock slack when matching subagent turns to the parent turn's time span

// Every item of the turn as { threadId, turnId, item }, in item order. A subagent's items come
// where the parent turn links to it (subAgentActivity), from the subagent turns that ran within
// the parent turn's time span. Three levels deep; a subagent thread that cannot be read is skipped.
export async function walkTurn(rpc, threadId, turn, { depth = 3, seen = new Set() } = {}) {
  seen.add(threadId);
  const out = [];
  for (const item of turn.items ?? []) {
    out.push({ threadId, turnId: turn.id, item });
    if (item.type !== "subAgentActivity" || !item.agentThreadId || depth <= 0 || seen.has(item.agentThreadId)) continue;
    seen.add(item.agentThreadId);
    let turns = [];
    try {
      turns = (await rpc.request("thread/turns/list", { threadId: item.agentThreadId, limit: 20, itemsView: "full" })).data ?? [];
    } catch { continue; }
    const from = (turn.startedAt ?? 0) - SLACK_S;
    const to = turn.completedAt ? turn.completedAt + SLACK_S : Infinity;
    for (const t of turns) {
      if (t.startedAt != null && (t.startedAt < from || t.startedAt > to)) continue; // an earlier job of a reused subagent
      out.push(...await walkTurn(rpc, item.agentThreadId, t, { depth: depth - 1, seen }));
    }
  }
  return out;
}

// A tool call that failed because nobody approved it. Codex words this differently per tool, so
// the matcher is one regular expression kept here and tested on its own. It needs an approval
// phrase: "permission denied", "access denied" or "rejected: 429" are ordinary failures.
const REFUSAL_RE = /\b(?:not approved|unapproved|approval|approve|user (?:rejected|declined|denied))\b/i;
export const soundsRefused = text => REFUSAL_RE.test(String(text ?? ""));

const textOf = items => (items ?? []).filter(c => c?.type === "inputText" || c?.type === "text").map(c => c.text).join(" ").trim();

// Sessions co-codex starts run with approvalPolicy "never": an action that needs approval is
// refused, and Codex may only mention it in passing. These are those actions, as data.
export function declinedActions(entries) {
  const out = [];
  for (const { item } of entries) {
    if (item.type === "commandExecution" && item.status === "declined") {
      out.push({ type: item.type, action: item.command ?? "(command)", reason: item.aggregatedOutput?.trim() || "declined: needs approval" });
    } else if (item.type === "fileChange" && item.status === "declined") {
      const files = (item.changes ?? []).map(c => c.path).filter(Boolean);
      out.push({ type: item.type, action: files.length ? `edit ${files.join(", ")}` : "file change", reason: "declined: needs approval" });
    } else if (item.type === "mcpToolCall" && item.status === "failed" && soundsRefused(item.error?.message)) {
      out.push({ type: item.type, action: `${item.server}.${item.tool}`, reason: item.error.message });
    } else if (item.type === "dynamicToolCall" && item.status === "failed") {
      const reason = textOf(item.contentItems);
      if (soundsRefused(reason)) out.push({ type: item.type, action: item.namespace ? `${item.namespace}.${item.tool}` : item.tool, reason });
    }
  }
  return out;
}
