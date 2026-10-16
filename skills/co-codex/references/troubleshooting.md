# How co-codex works, and what to do when it does not

## The moving parts

- Every Codex client on a machine (terminal `codex`, desktop app, IDE extension) is a client of one
  local app-server daemon. Its control socket is `~/.codex/app-server-control/app-server-control.sock`
  (`$CODEX_HOME` moves it).
- `codex app-server proxy` connects stdio to that socket. The socket speaks WebSocket: an HTTP
  upgrade, then JSON-RPC 2.0 messages in text frames. `lib/daemon.mjs` implements that client with
  no dependencies.
- co-codex is one more client. It can queue a message on a thread another client holds
  (`thread/queue/add`); the person at that window sees the whole turn live.
- Codex's own image tool saves each image and records `savedPath` on the turn's `imageGeneration`
  item. Subagents run in their own threads, linked from the parent turn by `subAgentActivity` items;
  `images` follows those links (three levels deep).

## Checks

| Symptom | Cause and fix |
|---|---|
| `cannot find the codex command` | Install Codex, or set `CO_CODEX_BIN` to the executable's full path. co-codex searches PATH in order (on Windows `codex.exe` before `codex.cmd` within a folder), then on macOS and Linux `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin` and `~/.volta/bin`, for apps started without your shell's PATH. |
| `the Codex daemon is not running; starting it` | Normal: co-codex runs `codex app-server daemon start` and connects within a few seconds. If that fails, run it yourself to see the error. |
| `doctor` reports missing methods | Codex changed its protocol. Update co-codex; if no update exists yet, pin the previous Codex version. |
| `no open Codex window in this project` | `open` only matches a window whose working directory is this project (the git top level). Start `codex` here, or address the session by name or id. |
| `is not open in any Codex window` | A saved session of yours that no window holds is refused on purpose, because nobody could answer its approval prompts. Open it with `codex resume <name>`, or `spawn` a new session. |
| `send` waits a long time | The message is queued behind the turn the window is running. `wait <session> --message <id>` follows it. |
| `stays on <model> because the message has not started yet` | `send --tier --wait` timed out while the message was still queued. Switching back then would run it on the old model, so the session keeps the tier model; switch it back later with `send ... --model <old> --keep` or `/model` in the window. |
| Requests hang | Every daemon request gives up after 120 s and the connection after 30 s, with a message naming the method. |
| A new window's answer arrives late | A thread cannot be subscribed until it has had one turn ("no rollout found"); co-codex then reads the answer from the history every 5 s. |
| Exit code 2 | `--timeout` (default 3600 s) passed. Codex keeps working; run `wait <session>`. |
| Exit code 4 | Usage limit. The message names the reset time; `limits` shows all windows. |
| `!` lines on stderr | Codex waits for an approval. Answer in the Codex window; co-codex never approves. |

## After a Codex update

1. `node <skill dir>/scripts/co-codex.mjs doctor`. It exports the installed protocol schema
   (`codex app-server generate-json-schema --experimental`) and checks every method and event
   co-codex uses.
2. A live smoke test that costs one short turn:
   `spawn "Reply with OK." --name co-codex-smoke --tier draft --sandbox read-only --wait`,
   then `codex delete --force <its uuid>` (the UUID is in the spawn line; without a terminal Codex needs `--force`).

## Platforms

- Windows, macOS and Linux run the same code. Paths are compared case-insensitively on Windows and
  macOS and through `realpath`, so `/tmp` and `/private/tmp` on macOS match.
- On Windows, if only the npm `codex.cmd` shim exists, co-codex starts it through `cmd.exe` and ends
  it by process id when done.
- Config lives in `~/.config/co-codex/config.json` on every platform (`$XDG_CONFIG_HOME` and
  `CO_CODEX_CONFIG` are respected).

## Environment variables

| Variable | Effect |
|---|---|
| `CO_CODEX_BIN` | Path of the `codex` executable, or a JSON array such as `["node", "/path/to/wrapper.mjs"]` |
| `CO_CODEX_CONFIG` | Path of the user config file |
| `XDG_CONFIG_HOME` | Base folder of the user config (default `~/.config`) |
