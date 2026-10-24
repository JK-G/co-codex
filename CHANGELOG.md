# Changelog

## 0.4.0 (2026-10-24)

- SKILL.md: "Mockups before UI code". Before Claude codes a new web page, landing page, app screen or visible redesign, it can ask the user once whether Codex should first draw 2-4 variants on `draft` (style directions, greyscale wireframes or high-fidelity mockups, by what is still open). It does not ask for small changes, when a design is given, after a no, or from a subagent; a standing preference in CLAUDE.md or memory decides without asking. The mockup sets the direction, never the spec, and is never shipped. The skill description now names this case, so the skill loads before UI work.
- `references/image-briefs.md`: templates for wireframes and style directions, and a note that one image holds about one screen.
- Trigger evals for the new case: two UI builds that must load the skill (English and Polish) and a CSS fix that must not.

## 0.3.0 (2026-10-18)

From a project that used 0.2.0 for about ten image batches and a deploy.

- `spawn --network`: workspace-write with network access, for installs, deploys and anything online. Every spawn reports its `sandbox` and `network` (status line and `--json`), read from what Codex says it started. co-codex warns, without blocking, when a task contains a command such as `npm install`, `git push` or "deploy to" and the session has no network (never for `--images` runs, which are read-only by design). `send` now refuses `--sandbox` and `--network` instead of ignoring them, because Codex fixes the sandbox when a session starts.
- `doctor` shows Codex's own sandbox settings for the project (`sandbox_mode`, `sandbox_workspace_write.network_access`, `approval_policy`) next to what co-codex spawns with.
- Actions refused for lack of approval come back as data: `declined: [{type, action, reason}]` in `--json` (declined commands and file changes, and tool calls that failed with an approval message, subagents included). In a session co-codex started (approvals off) they also print a `!` block on stderr with the retry command, `codex resume <name> -a on-request`, and end with the new exit code 5; exit codes 4 and 3 still take precedence. In a window a person holds, the declines were theirs: a stderr note, `declined` in the JSON, exit code 0.
- `--names a.png,b.png` on `spawn`, `send` and `wait`: Codex ends its answer with a `KEEP:` line and co-codex copies the kept images under the requested names, the others to `<out>/_rejected/`. Falls back to order when the count matches, else to item-id names, with a warning and `namesMatchedBy` in the JSON. Never overwrites a different file. Not with `--subagents`; images from subagents Codex starts on its own go to `_rejected/`.
- Every image in the JSON results and in `co-codex-images.jsonl` has its real `width` and `height`, read from the PNG header. There is no `--resize`: it would need an image library, and co-codex has no dependencies.
- `cleanup [--older-than 2d] [--name-prefix p] [--yes]`: lists, and with `--yes` deletes, sessions co-codex started in this project that no window has open. Dry run by default. Outside a git repository only sessions of that exact folder count, and a session whose last message a person typed is skipped ("used in a Codex window").
- Quota per batch: runs with `--wait` report `usage` (the five-hour and weekly windows before and after). Completed `--images` runs are logged in `~/.config/co-codex/usage.jsonl` (`$XDG_CONFIG_HOME` respected), and `limits --estimate <n> [--tier t]` gives the share for n images as summed window use over summed images, since Codex reports whole percents.
- SKILL.md: a sandbox table, one "Long tasks" recipe, `--names` in the image workflow, real output sizes, exit code 5 and `cleanup`.

## 0.2.0 (2026-10-16)

- `opinion`: an independent, read-only second opinion from Codex on a plan, decision, design or text, with a structured verdict, ranked concerns, alternatives and questions; `--mode challenge` asks Codex to refute Claude's position; `--diff`, `--base` and `--commit` run Codex's built-in code reviewer. The skill runs it only on the user's request or a standing preference, always in addition to Claude's own review.
- The skill now takes over plain image requests ("generate an image of ...", "wygeneruj mi obraz") without the user naming Codex. Trigger evals in `evals/` for `claude plugin eval`.
- `wait --message <id>`; `send` prints the message id. `send --tier` needs `--wait` or `--keep`.
- Polling uses the small summary view of the history; a turn only counts as finished when the summary and full views agree.
- Request and connection timeouts, PATH order and macOS/Linux fallback folders when looking for `codex`, `CO_CODEX_DEBUG=1` for event logs.

## 0.1.0 (2026-10-16)

First public version.

- `list`, `spawn`, `send`, `wait`, `read`, `stop` for Codex sessions on the local app-server daemon, including a Codex window that is already open.
- Quality tiers (`draft`, `standard`, `high`, `max`) resolved against the models the account offers; `send --tier` switches the window back after the turn.
- `images`: every image of a turn, subagent threads included, copied with a JSONL log.
- `limits`, exit code 4 with the reset time when a turn hits the usage limit.
- `doctor`: checks Codex, the daemon, sign-in, tiers and the protocol methods used.
- `init`: the AGENTS.md note that tells Codex how to answer.
- Starts the daemon when it is not running. Windows, macOS and Linux.
