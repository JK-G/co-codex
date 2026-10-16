---
name: co-codex
description: Generate images, and hand other work to OpenAI Codex. Claude cannot create images itself, so use this skill whenever the user asks for an image in any wording or language - generate, create, draw, make, design or edit an image, picture, photo, illustration, icon, logo, sprite, texture, mockup, banner, poster, thumbnail or ad creative (Polish - wygeneruj obraz, zrób grafikę, narysuj, stwórz obrazek, ikonę, logo, zdjęcie). Codex makes the image with gpt-image-2 on the user's ChatGPT plan and the files come back into the project. Also use it when the user asks to give a task to Codex, ask or check on Codex, or run work on their Codex quota instead of Claude's. It messages an open Codex window or starts a session, picks a quality tier (draft, standard, high, max) that sets the Codex model and effort, and collects every image, subagents included. When the user asks for it, or a standing preference of theirs says so, it also gets an independent second opinion from Codex on a plan, decision, design or code diff, in addition to Claude's own review and never instead of it.
---

# co-codex

`scripts/co-codex.mjs` talks to the local Codex daemon, which hosts every Codex session on this
machine: a `codex` window open in a terminal, the desktop app, and sessions co-codex starts
itself. Run it from the project root:

```
node "${CLAUDE_SKILL_DIR}/scripts/co-codex.mjs" <command> [options]
```

`help` prints the full usage. Stdout carries only Codex's final answer (or JSON with `--json`);
status lines go to stderr.

| Command | What it does |
|---|---|
| `list [--all]` | Open sessions (id, status, name, model); `--all` adds saved ones in this project |
| `spawn "<task>" --name <name> [--tier t] [--wait]` | New named session with the task |
| `send <session> "<task>" [--tier t] [--wait]` | Queue a message; it runs after Codex's current turn |
| `wait <session> [--message id]` | Wait for a turn and print its answer (the id `send` prints, else the last queued message, else the latest turn) |
| `read <session> [--turns n]` / `stop <session>` | Print recent answers, interrupt the running turn |
| `images <session> [--turns n] [--out dir]` | List or copy the images of recent turns, subagents included |
| `opinion <text> [--mode challenge]` / `opinion --diff` | Read-only second opinion: a verdict on a plan or decision, or Codex's code review of a diff |
| `models` / `limits` / `doctor` | Tier resolution, quota left and reset times, setup check |
| `init [--write]` | Print, or append to ./AGENTS.md, the note that tells Codex how to answer |

`<session>` is a UUID, an exact session name, or `open` (the one Codex window open in this
project). Pass long tasks as `-` and pipe them on stdin.

## When the user simply asks for an image

Do not answer that you cannot make images, and do not interview the user. Go:

1. Turn the request into a brief: subject, style, aspect or size, background (transparent when
   it is an icon, sprite or logo), every word of text exactly as it must appear. Fill gaps with
   sensible choices and name them in your reply. Ask only when something essential is unknowable,
   such as the exact wording of a logo.
2. Start a fresh session that only generates (read-only sandbox: Codex writes nothing, co-codex
   copies the files), with Bash `run_in_background: true`, since images take a minute or more:

   ```
   node "${CLAUDE_SKILL_DIR}/scripts/co-codex.mjs" spawn "<brief>" --name img-<short-slug> --tier standard --images --sandbox read-only --wait --out <folder> --json
   ```

   Tier: `draft` when the user wants something quick, a sketch or several options; `high` for
   final, production or print use; `max` only when asked. Folder: where the user said, else the
   project's existing images or assets folder, else `./generated-images`. Several images or
   variants in one request: one session, with the count in the brief.
3. When it finishes, Read every copied PNG, check it against the brief, and give the user the
   file paths with one line on what you checked. Say in one line that it used their Codex quota.
4. Changes ("make it bluer", "without the text"): send them to the same session with the
   previous file attached:
   `send img-<short-slug> "<change>" --ref <previous file> --images --wait --out <folder> --json`.
5. If `doctor` or the command says Codex is missing or signed out, tell the user to install
   Codex (https://developers.openai.com/codex) and run `codex login`.

## Second opinion from Codex (optional, always in addition)

Codex is a different model family, so it misses different things. `opinion` asks it for an
independent review in a fresh read-only session. It is an extra layer on top of your own work,
never a replacement for your analysis, for a reviewer the user chose (such as an Opus or Fable
subagent), or for the user's decision.

**When to run it**

- The user asks for it in this conversation: "ask Codex for a second opinion", "let Codex check
  this plan", "zapytaj Codexa o zdanie", "niech Codex to zweryfikuje", "zderz to z Codexem".
- Or a standing preference says so: CLAUDE.md, project instructions or memory tell you to get
  Codex's opinion on this kind of work, or memory shows the user asked for it on the same kind of
  work at least twice before. Then run it without asking, and say in one line which preference
  you followed and that the user can switch it off.
- The second time the user asks for a Codex opinion on similar work, offer once to save it as a
  standing preference, naming the kind of work (for example "deployment and migration plans").
  Save it only after a yes.
- Otherwise do not run it. For a high-stakes plan or decision (production deployment, data
  migration, architecture, security) you may mention once per conversation that a Codex second
  opinion is available. Never for routine work, and not again after the user declines.

**How**

1. Do your own review as you would anyway. Start Codex in parallel with Bash
   `run_in_background: true`; an opinion takes a few minutes.
2. Plans, decisions, designs and copy: send the goal, the constraints and the material itself, and
   list the files Codex should read. Leave your own verdict out, so Codex's view stays independent:

   ```
   node "${CLAUDE_SKILL_DIR}/scripts/co-codex.mjs" opinion - --on "<what it is>" --file <path> --json < material.md
   ```

   Use `--mode challenge`, with your position in the text, when the user wants your reasoning
   attacked or when you and the user disagree.
3. Code changes: `opinion --diff` (uncommitted), `--base <branch>` or `--commit <sha>` runs Codex's
   built-in code reviewer.
4. Tier: `high` by default; `max` for decisions that are expensive to undo; `standard` for a
   quick check.

**Using the answer**

- Codex's opinion is evidence, not authority. Check every concern against the code or the facts
  before you accept it.
- Report in three parts: where you and Codex agree, what Codex found that you missed (and whether
  you verified it), and where you disagree with Codex and why. Quote its verdict and confidence.
- The user decides. Do not change the plan on Codex's word alone.

## Before the first task

- Run `doctor` if you have not used co-codex on this machine yet. It starts the daemon when it is
  down and says what is missing (Codex not installed, not signed in, protocol changed).
- If the project's AGENTS.md has no co-codex note, run `init` and show it to the user. Run
  `init --write` only with their agreement: it edits a file Codex reads on every turn.

## Where the task goes

1. Run `list`. If the user has a Codex window open in this project, `send open "<task>"`.
2. Otherwise `spawn "<task>" --name <short-kebab-name>`. The user can watch it with
   `codex resume <name>`.
3. Claude and Codex share the working tree. Split the files clearly in the task, or spawn with
   `--cwd <path of a separate git worktree>`.

## Choosing a tier

| Tier | Model (first one this account offers) | Use it for |
|---|---|---|
| `draft` | gpt-6-luna, medium effort | sketches, thumbnails, many variants, quick checks |
| `standard` | gpt-6.1-sol, medium | normal assets and routine work |
| `high` | gpt-6.1-sol, high | final assets, careful edits |
| `max` | gpt-6-astra, high | hero images or work that failed on `high`; costs about 5x `high` per token |

- No `--tier` means Codex's own default model and effort (or `defaultTier` from the config).
- Pick the cheapest tier that fits and say which one you chose. Escalate one tier when a result
  is weak instead of resending the same task on the same tier.
- `models` shows what each tier resolves to on this account. `--model` and `--effort` override
  the tier. On `send` a tier changes the model of that session, so it needs `--wait` (the session
  switches back once the turn has started) or `--keep` (it stays on the new model).
- Tiers change who writes the image prompts and how hard results are checked and redone. They do
  not change the image model (Codex always uses gpt-image-2) or the output resolution.
  Details: `references/tiers.md`.

## Writing the task

Codex sees only your message and the project's AGENTS.md. Make the message self-contained:

- the goal, the files it may change, the output folder and file names;
- acceptance criteria it can check by itself;
- what its final answer must contain.

For images also give the size or aspect, the background (say "real transparent background" when
you need alpha), the style and the count, and attach references with `--ref <file>` (say which
one is the edit target and which are style references only). Add `--images` so the tier's quality
rules go into the message. For batches add `--subagents`: Codex then splits the work across its
own subagents. Templates for game art, UI mockups and ad creatives: `references/image-briefs.md`.

## Running and waiting

- For anything longer than a minute, run `spawn ... --wait` or `send ... --wait` with Bash
  `run_in_background: true`. You are notified when it exits; stdout holds the answer.
- `send` without `--wait` prints the message id; `wait <session> --message <id>` picks that turn up
  later, even when it was queued behind other work.
- `--out <dir>` copies the turn's images there and logs each in `co-codex-images.jsonl`.
  `--json` returns the answer, model, image paths and limit status as one object.
- Look at the images yourself (Read the PNG) before you report them as done.

| Exit | Meaning | What to do |
|---|---|---|
| 0 | answered | use the answer |
| 2 | timed out, Codex keeps working | run `wait <session>` again |
| 3 | turn failed or was interrupted | read the error, fix the task, resend |
| 4 | usage limit reached | tell the user the reset time from the message; resend the unfinished part after it |
| 1 | co-codex error | read the message; run `doctor` |

## Rules

- Tell the user each time you send work to Codex. It runs on their ChatGPT plan and spends their
  Codex quota; image generation spends it 3-5x faster than text. Run `limits` before a large batch.
- A line starting with `!` means Codex waits for an approval. co-codex never approves; ask the
  user to answer in the Codex window. Never try to approve on Codex's behalf.
- Spawned sessions run in the `workspace-write` sandbox with approval prompts off, so blocked
  commands go back to Codex instead of waiting. Use `--sandbox danger-full-access` only when the
  user allows it or their config sets it; `--sandbox read-only` for a session that must not write.
- Codex cannot message you on its own. If it needs something, it ends its turn with a question,
  which arrives as its answer. Reply with another `send`.
- Remove throwaway sessions you spawned once the user no longer needs them:
  `codex delete --force <session uuid>` (without a terminal, Codex needs `--force` and the UUID).

## If it breaks

Run `doctor`. The daemon protocol is marked experimental and Codex updates often; `doctor`
exports the schema of the installed Codex and checks every method co-codex uses. If `codex` is
not on PATH, set `CO_CODEX_BIN` to its full path. More in `references/troubleshooting.md`.
