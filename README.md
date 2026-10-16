# co-codex

[![tests](https://github.com/JK-G/co-codex/actions/workflows/test.yml/badge.svg)](https://github.com/JK-G/co-codex/actions/workflows/test.yml)

co-codex lets Claude Code give tasks to OpenAI Codex and read the answers. It can message the Codex window you already have open or start a new session. Four quality tiers pick the Codex model and reasoning effort for each task, and every image Codex generated comes back to you, including the ones its subagents made.

It grew out of one job: generating game art with Codex's image tool while Claude Code wrote the briefs and put the results into the game. The same loop works for UI mockups, ad creatives, icons and illustrations, and for any coding task you would rather run on your Codex quota than on Claude's.

Unofficial. Not affiliated with OpenAI or Anthropic.

## What it does

- `spawn` and `send` give Codex a task, in a new named session or in a window you have open. `--wait` blocks until Codex answers and prints the answer.
- `--tier draft|standard|high|max` chooses the model and effort from the models your account offers: GPT-6 Luna for drafts, GPT-6.1 Sol for everyday and final work, GPT-6 Astra for the hardest jobs.
- `images` lists or copies every image a turn produced, following subagent threads, and logs each file with its prompt in `co-codex-images.jsonl`.
- `limits` shows how much of the five-hour and weekly windows you have used and when they reset. A turn that runs into the limit exits with code 4 and the reset time.
- `opinion` asks Codex for an independent, read-only second opinion on a plan, a decision or a code change, in addition to Claude's own review.
- `doctor` checks Codex, the daemon, your sign-in, the tier models, and every protocol method co-codex relies on.

## Requirements

- [Codex CLI](https://developers.openai.com/codex), signed in with a ChatGPT plan that includes Codex. Tested with Codex CLI 0.162.1 and app-server 0.163.0.
- Node.js 20 or newer. No npm dependencies.
- Windows, macOS or Linux (see [Platform support](#platform-support)).

## Install

As a Claude Code plugin:

```
/plugin marketplace add JK-G/co-codex
/plugin install co-codex@co-codex
```

The same from a shell: `claude plugin marketplace add JK-G/co-codex`, then `claude plugin install co-codex@co-codex`.

As a plain skill, without the plugin system:

```
git clone https://github.com/JK-G/co-codex
cp -r co-codex/skills/co-codex ~/.claude/skills/
```

On Windows PowerShell, use `Copy-Item -Recurse co-codex\skills\co-codex $HOME\.claude\skills\` for the copy.

Then ask Claude Code to "run co-codex doctor", or run it yourself:

```
node ~/.claude/skills/co-codex/scripts/co-codex.mjs doctor
```

The CLI is a single Node script, so any agent that can run shell commands can use it. Only `SKILL.md` is specific to Claude Code. To run it without cloning: `npx -y github:JK-G/co-codex doctor`.

## Quick start

In Claude Code, just ask for the image: "generate an image of a red apple", "make me an app icon for a weather app", or in Polish "wygeneruj mi obraz". You do not have to mention Codex. Claude cannot draw by itself, so the skill takes over: it writes the brief, starts a Codex session, waits, copies the PNG into your project (`./generated-images` unless you name a folder or the project has an assets folder) and checks it before showing you the path. Follow-ups such as "make it bluer" go to the same session with the previous image attached.

Tasks for Codex work the same way: "Have Codex review this module and tell me what it found."

To drive it by hand (`co-codex` below stands for `node <skill dir>/scripts/co-codex.mjs`):

```
co-codex list        # Codex sessions open on this machine
co-codex models      # what each tier resolves to on your account
co-codex limits      # quota used and reset times

co-codex spawn "Generate one game icon: a red apple, flat colours, transparent background." \
  --name apple-icon --tier draft --images --wait --out art/icons --json

co-codex send apple-icon "Make it glossy and keep the silhouette." --tier high --images --wait --out art/icons
```

The first command, as it ran on 2026-10-16 (paths shortened):

```json
{
  "name": "apple-icon",
  "status": "completed",
  "tier": "draft",
  "model": "gpt-6-luna",
  "effort": "medium",
  "answer": "Generated one draft apple icon with a transparent background.",
  "images": [{ "path": "~/.codex/generated_images/01a145e3-.../exec-1a46....png", "transparent": true }],
  "copied": ["art/icons/exec-1a46....png"],
  "limit": null
}
```

`send` with `--tier high` ran that one turn on GPT-6.1 Sol with high effort, then switched the session back to GPT-6 Luna. On `send`, a tier needs `--wait` (switch back after the turn) or `--keep` (stay on the new model).

## Quality tiers

| Tier | Models tried in order | Effort | What `--images` adds to the task |
|---|---|---|---|
| `draft` | gpt-6-luna, gpt-5.6-luna | medium | one attempt per image, no regenerating unless unusable |
| `standard` | gpt-6.1-sol, gpt-6-sol, gpt-5.6-sol | medium | check each result once, regenerate at most once |
| `high` | gpt-6.1-sol, gpt-6-sol, gpt-5.6-sol | high | check every point of the brief, up to 2 regenerations |
| `max` | gpt-6-astra, gpt-6.1-sol, gpt-6-sol | high | 2 variants per image, keep the better, up to 3 regenerations |

co-codex takes the first model on the list that your account offers right now, so a tier survives model renames. If a model does not support the tier's effort, it uses the strongest effort the model has below it.

What a tier does not change: Codex's built-in image generation always uses `gpt-image-2` ([OpenAI docs](https://learn.chatgpt.com/docs/image-generation)). The agent model decides how well the image prompt is written, how strictly the result is checked and how often it is redone. Output size does not shrink on `draft`: a draft run on GPT-6 Luna still returned a 1254x1254 image.

What it costs, per [OpenAI's pricing page](https://learn.chatgpt.com/docs/pricing) as of October 2026: per token, GPT-6 Luna costs 1/20 of GPT-6.1 Sol and GPT-6 Astra costs 5 times as much as Sol. Image generations use included limits about 3 to 5 times faster than similar turns without images.

Tiers are plain config. Change them or add your own in `~/.config/co-codex/config.json` (all projects) or `.co-codex.json` (one project); details in [references/tiers.md](skills/co-codex/references/tiers.md).

## The case behind it: game art on a ChatGPT Plus plan

A 2D pixel-art game prototype needed character sprite sheets, armour and weapon sets, props, portraits and UI art. Claude Code wrote the task pack (style guide, specs, one prompt file per task) and fitted the finished art into the game. Codex generated the images with gpt-image-2 on a ChatGPT Plus plan: 222 image calls between one afternoon and the next morning. Each problem we hit became part of co-codex:

- **Finding the right file.** Picking the newest file in `~/.codex/generated_images` breaks once subagents generate in parallel. co-codex reads each image's own `savedPath` from the turn and follows subagent threads. One turn of that run produced 74 images across three subagents, and `images --out` copied all of them with their prompts.
- **Batches.** One sequential art session filled 390k of its 475k-token context. `--subagents` asks Codex to split a batch across its own subagents, each with its own files.
- **Limits.** On Plus, about 78 image calls in roughly an hour used up the five-hour window, and the next turns failed. co-codex now exits with code 4 and prints the reset time, `limits` shows the windows before you start, and `images` still collects what finished.
- **Consistency.** Redressing a finished base sheet, attached as the edit target, kept all eight figures in place. The brief templates make you name each reference image's role.
- **Transparency.** Asked for a real transparent background, gpt-image-2 in Codex returned images with an alpha channel.

UI mockups and ads follow the same loop. Explore several variants on `draft`, pick one, then finalize it on `high` with the pick attached through `--ref`. [references/image-briefs.md](skills/co-codex/references/image-briefs.md) has brief templates for sprite sheets, UI mockups, ad creatives in several sizes, and icon sets.

## Second opinion from Codex

Claude can ask Codex to review a plan, a decision, a design or a code change. Codex is a different model family, so it tends to miss different things than Claude does. It is always an extra layer: Claude still does its own review, and you decide.

- It runs only when you ask ("get a second opinion from Codex on this plan", "zapytaj Codexa o zdanie"), or when your CLAUDE.md or Claude's memory says to do it for that kind of work. The second time you ask on similar work, Claude offers to save it as a standing preference.
- Codex works in a fresh read-only session. It can read the project and check claims against the code, but it cannot change anything.
- By default Codex does not see Claude's conclusion, so its view is not anchored to it. `--mode challenge` sends Claude's position and asks Codex to refute it.
- Plans and decisions come back as a verdict (`sound`, `sound-with-changes` or `rethink`), a confidence level, ranked concerns with evidence, alternatives and questions. Code changes go through Codex's built-in reviewer: `--diff` for uncommitted changes, `--base <branch>`, or `--commit <sha>`.
- Claude then reports where both agree, what Codex found that Claude missed, and where Claude disagrees with Codex and why.

A run from 2026-10-16 on a deliberately flawed migration plan (trimmed):

```
co-codex opinion "Goal: rename users.email to users.login_email in a production Postgres database, zero downtime.
Plan: 1. Deploy the app version that uses login_email. 2. ALTER TABLE users RENAME COLUMN email TO login_email.
3. No rollback plan needed, a rename is instant." --on "database migration plan"

Verdict: rethink (confidence high)
The proposed ordering breaks live requests and does not meet zero-downtime requirements.

Concerns:
  [high] Step 1 deploys code against a column that does not exist yet.
  [high] A fast metadata operation can still cause an outage through locking.
      evidence: PostgreSQL specifies ACCESS EXCLUSIVE as the default ALTER TABLE lock ...
  [medium] Execution speed does not eliminate the need for rollback and validation.

Alternatives:
  - Use expand-and-contract: add a nullable login_email, ... finally remove email after every old consumer is retired.
```

On a small diff that changed a bill-splitting function to round every share, `opinion --diff` returned a P1 finding with the file and line: `split(10, 3)` now returns `[3, 3, 3]`, which no longer adds up to the total.

## Commands

| Command | What it does |
|---|---|
| `list [--all]` | Open sessions with status, name and model; `--all` adds saved sessions of this project |
| `spawn <task> --name <name>` | Start a named session with the task |
| `send <session> <task>` | Queue a message; it runs after the session's current turn |
| `wait <session> [--message id]` | Wait for a turn and print its answer: the message `send` queued, else the last queued one, else the latest turn |
| `read <session> [--turns n]` | Print recent answers |
| `stop <session>` | Interrupt the running turn |
| `images <session> [--turns n] [--out dir]` | List or copy the images of recent turns, subagents included |
| `opinion <text> [--on what] [--mode challenge] [--file path]` | Read-only second opinion on a plan, decision, design or text |
| `opinion --diff \| --base <branch> \| --commit <sha>` | Codex's built-in code review of a change |
| `models` | Models on your account and how each tier resolves |
| `limits` | Usage of the current windows and reset times |
| `doctor` | Check the setup and the protocol |
| `init [--write]` | Print the AGENTS.md note for Codex, or append it to `./AGENTS.md` |

Options for `spawn` and `send`: `--tier`, `--model`, `--effort`, `--images`, `--subagents`, `--ref <image>` (repeatable), `--wait`, `--timeout <s>`, `--out <dir>`, `--json`. `spawn` also takes `--cwd`, `--sandbox` and `--fast`. `<session>` is a session id, an exact name, or `open` for the one Codex window open in the current project. Pass `-` as the task to read it from stdin.

Exit codes: 0 answered, 1 co-codex error, 2 timed out (Codex keeps working, run `wait`), 3 turn failed or was interrupted, 4 usage limit reached.

## Configuration

co-codex works without a config file. To change defaults, create `~/.config/co-codex/config.json` or a `.co-codex.json` in the project; the project file wins, and only the fields you set change:

```json
{
  "defaultTier": "standard",
  "spawn": { "sandbox": "workspace-write", "approvalPolicy": "never" },
  "tiers": { "draft": { "effort": "low" } }
}
```

[templates/co-codex.config.json](skills/co-codex/templates/co-codex.config.json) lists every setting.

## Safety and cost

- Every task spends the Codex quota of your ChatGPT plan. The skill tells Claude to say so each time it sends work and to check `limits` before a batch.
- Spawned sessions run in the `workspace-write` sandbox with approval prompts off: nobody watches them, so a blocked command goes back to Codex instead of waiting forever. Set `"sandbox": "danger-full-access"` in your config if you want spawned sessions to run without the sandbox.
- co-codex never answers approval prompts. It prints a line starting with `!` and leaves the decision to the person at the Codex window.
- It refuses to send to one of your saved sessions that no window has open, because nobody could answer that session's prompts.
- `init --write` appends a short note to `AGENTS.md`, and the skill asks before running it.

## How it works

Every Codex client on a machine (terminal, desktop app, IDE extension) talks to one local app-server daemon. co-codex starts `codex app-server proxy`, which connects to the daemon's socket, and speaks JSON-RPC over WebSocket frames on the proxy's stdin and stdout. That makes it one more client of the same daemon: it can queue a message on a session your terminal holds, and you watch the turn happen in your window. If the daemon is not running, co-codex starts it.

OpenAI marks the app-server protocol as experimental, and Codex ships often. `doctor` exports the protocol schema of the installed Codex and checks every method co-codex uses, so a breaking change shows up as a clear message.

## Platform support

- **Windows:** tested live on Windows 11 with Codex CLI 0.162.1.
- **macOS and Linux:** the same code. CI runs the full test suite against a mock Codex on Ubuntu, macOS and Windows. It has not yet been run against a real Codex on macOS or Linux, so reports are welcome.

Paths are compared case-insensitively on Windows and macOS and through `realpath` everywhere. If `codex` is not on your PATH, set `CO_CODEX_BIN` to the executable. More in [references/troubleshooting.md](skills/co-codex/references/troubleshooting.md).

## Related

If you mainly want Codex to review code from inside Claude Code, look at OpenAI's official plugin [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) first. co-codex is built around handing whole tasks to Codex, choosing the model per task, and getting images back.

## Tests

- `npm test` runs 64 unit and end-to-end tests against a mock Codex. CI runs them on Ubuntu, macOS and Windows with Node 20, 22 and 24.
- `claude plugin eval . --no-publish` runs the trigger evals in `evals/`: 9 requests that must load the skill (image requests in English and Polish that never name Codex, a task for Codex, two requests for a second opinion) and 5 that must not (image-processing code, a question about images on a website, a plan review and a code review that do not mention Codex, a general question). On 2026-10-16 all 14 passed twice each with Claude Code 2.1.301. A full run cost about $4 of Claude usage.

## License

MIT. Issues and pull requests are welcome; please include your OS and the output of `doctor`.
