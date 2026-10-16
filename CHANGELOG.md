# Changelog

## 0.1.0 (2026-10-16)

First public version.

- `list`, `spawn`, `send`, `wait`, `read`, `stop` for Codex sessions on the local app-server daemon, including a Codex window that is already open.
- Quality tiers (`draft`, `standard`, `high`, `max`) resolved against the models the account offers; `send --tier` switches the window back after the turn.
- `images`: every image of a turn, subagent threads included, copied with a JSONL log.
- `limits`, exit code 4 with the reset time when a turn hits the usage limit.
- `doctor`: checks Codex, the daemon, sign-in, tiers and the protocol methods used.
- `init`: the AGENTS.md note that tells Codex how to answer.
- Starts the daemon when it is not running. Windows, macOS and Linux.
