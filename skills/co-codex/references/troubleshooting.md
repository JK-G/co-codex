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
| `was not loaded on the daemon` or `could not load ... again` | A session co-codex started that nothing held any more, typically after a restart. When reloading it or its next turn fails (seen: "Bad Request"), spawn a new session and attach the last image you kept with `--ref`. A failed turn's images keep their item ids. |
| `the sandbox is fixed when a session starts` | `send` got a `--sandbox` or `--network` other than the session's own (repeating the same one is fine). Spawn a new session for another sandbox. |
| Exit code 2 | `--timeout` (default 3600 s) passed. Codex keeps working; run `wait <session>`. In Claude Code's foreground Bash, which stops a command after 10 minutes, pass `--timeout 540`. |
| Exit code 4 | Usage limit, or a window above `--max-used` / `maxUsedPercent` (then nothing was sent). The message names the reset time; `limits` shows all windows. |
| A script runs an old co-codex after an update | It names a plugin-cache path with a version in it. Call the launcher instead (`doctor` prints its path). `doctor` also says when a newer co-codex is out. |
| Exit code 5 | Codex answered, but some actions needed an approval that nobody could give (sessions co-codex starts run with approval policy `never`). They are listed on stderr and in `--json` as `declined`. Open `codex resume <name> -a on-request` and let Codex retry there; you approve each action in that window. If the retry needs the network, add `-c sandbox_workspace_write.network_access=true`, or `-s danger-full-access` if you accept that. In a window you hold, declines are your own and co-codex exits 0. |
| `!` lines on stderr | Codex waits for an approval, or (after a turn) lists the actions it was refused. Answer in the Codex window; co-codex never approves. |
| Installs, deploys or downloads fail inside Codex | The session has no network access. `spawn` prints `network off` and warns when the task contains a command such as `npm install` or `git push`. The sandbox is fixed per session, so `send` cannot fix it: spawn a new session with `--network`, or with `--sandbox danger-full-access` if you allow it. `doctor` shows Codex's own sandbox settings next to co-codex's. |
| `could not match names` or `mapped by order, check them` | `--names` found no usable `KEEP:` line in Codex's answer. With as many images as names, co-codex maps them in order (`namesMatchedBy: "order"`), so check each file. Otherwise it copies the images under their item ids (`namesMatchedBy: null`) and you name them yourself. |
| `<name> already exists with other content` | `--names` never overwrites a different file; this image went to `<name>-2.png`. On a correction turn, pass `--replace`: the name gets the new image and the old file moves to `_rejected/<name>-replaced.png`. |
| `limits --estimate` says the runs were logged before co-codex recorded start times | Runs logged by 0.4.0 or older recorded only how far each run moved the window, so parallel runs counted each other's use and the estimate can be several times too high. Runs from 0.5.0 on record their start and are measured together where they overlap; once there are any, the older ones are left out. |

## Cleaning up sessions

`cleanup` lists the sessions co-codex started in this project that no window has open and that
nobody used for 2 days (`--older-than 30m|12h|2d|1w`, `--name-prefix img-`). Nothing is deleted
until you add `--yes`. Sessions you started yourself are never listed, and neither is a spawned session whose last message a person typed in a Codex window (shown as skipped). Outside a git repository only sessions of the current folder count, not its subfolders. A session co-codex used
recently can stay loaded on the daemon for a while after co-codex exits; it counts as open and is
listed once the daemon has unloaded it. For a single session, `codex delete --force <session uuid>`
still works.

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
| `CO_CODEX_DEBUG` | Set to `1` to log daemon events and history polls on stderr |
| `CO_CODEX_UPDATE_URL` | Where `doctor` reads the newest version (default: `package.json` on GitHub's main branch); `off` skips the check |
| `CLAUDE_CONFIG_DIR` | Claude Code's folder (default `~/.claude`), where `doctor` and the launcher find the installed plugin |
