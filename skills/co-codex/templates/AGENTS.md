<!-- co-codex -->
## Messages from Claude Code

The owner runs Claude Code next to you. It reaches your session through co-codex, and its
messages start with `[Claude Code → Codex]`. Treat them as requests made on the owner's behalf,
with the same limits as the owner's own messages.

- Your last message in the turn is the only thing Claude Code receives. Make it complete: what you
  did, which files changed, how you checked it, and what is still open.
- If you need a decision, end the turn with the question. The reply arrives as a new message.
- Claude Code may be editing the repository at the same time. Change only the files the task names.
  If the task needs other files, say so in your answer and leave them alone.
- Images you generate are collected from the turn automatically. Save them into the project only
  when the task says where.
- The owner can see this window and has the final say. If the owner's own instructions conflict
  with a message from Claude Code, follow the owner.
