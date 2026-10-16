// Finds the images a Codex turn generated, including those made by its subagents, and copies
// them out. Each imageGeneration item names its own file (savedPath, usually
// ~/.codex/generated_images/<thread>/<item>.png), so nothing guesses by "newest file".
import { appendFileSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const SLACK_S = 5; // clock slack when matching subagent turns to the parent turn's time span

export async function collectImages(rpc, threadId, turn, { depth = 3, seen = new Set() } = {}) {
  seen.add(threadId);
  const out = [];
  for (const item of turn.items ?? []) {
    if (item.type === "imageGeneration") {
      out.push({
        threadId,
        turnId: turn.id,
        itemId: item.id,
        status: item.status,
        savedPath: item.savedPath ?? null,
        transparent: item.transparentBackground ?? null,
        prompt: item.revisedPrompt ?? null,
        failure: item.failure ?? null,
        data: item.savedPath ? undefined : item.result, // base64 PNG when no file was saved
      });
    } else if (item.type === "subAgentActivity" && item.agentThreadId && depth > 0 && !seen.has(item.agentThreadId)) {
      seen.add(item.agentThreadId);
      let turns = [];
      try {
        turns = (await rpc.request("thread/turns/list", { threadId: item.agentThreadId, limit: 20, itemsView: "full" })).data ?? [];
      } catch { continue; } // a subagent thread that cannot be read is skipped, not fatal
      const from = (turn.startedAt ?? 0) - SLACK_S;
      const to = turn.completedAt ? turn.completedAt + SLACK_S : Infinity;
      for (const t of turns) {
        if (t.startedAt != null && (t.startedAt < from || t.startedAt > to)) continue; // an earlier job of a reused subagent
        out.push(...await collectImages(rpc, item.agentThreadId, t, { depth: depth - 1, seen }));
      }
    }
  }
  return out;
}

export const usableImages = images => images.filter(i => !i.failure && (i.savedPath || i.data));

// Copies each image into outDir as <item id>.png and appends one line per new file to
// outDir/co-codex-images.jsonl (source, prompt, transparency), so a batch keeps its record.
export function copyImages(images, outDir) {
  mkdirSync(outDir, { recursive: true });
  const copied = [];
  for (const img of usableImages(images)) {
    const ext = img.savedPath ? path.extname(img.savedPath) || ".png" : ".png";
    const file = path.join(outDir, `${img.itemId}${ext}`);
    if (img.savedPath) {
      if (!existsSync(img.savedPath)) continue;
      if (existsSync(file) && statSync(file).size === statSync(img.savedPath).size) { copied.push({ ...img, file, data: undefined, fresh: false }); continue; }
      copyFileSync(img.savedPath, file);
    } else {
      if (existsSync(file)) { copied.push({ ...img, file, data: undefined, fresh: false }); continue; } // item ids are unique, so it is the same image
      writeFileSync(file, Buffer.from(img.data, "base64"));
    }
    copied.push({ ...img, file, data: undefined, fresh: true });
    appendFileSync(path.join(outDir, "co-codex-images.jsonl"), JSON.stringify({
      file: path.basename(file),
      source: img.savedPath,
      threadId: img.threadId,
      turnId: img.turnId,
      transparent: img.transparent,
      prompt: img.prompt,
      copiedAt: new Date().toISOString(),
    }) + "\n");
  }
  return copied;
}

export function limitFailure(images) {
  const hit = images.find(i => i.failure?.type === "usageLimitExceeded");
  return hit ? { resetsAt: hit.failure.resetsAt ?? null, limitId: hit.failure.limitId ?? null } : null;
}
