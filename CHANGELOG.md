# Changelog

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
