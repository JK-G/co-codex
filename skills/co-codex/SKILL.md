---
name: co-codex
description: Generate images, and hand other work to OpenAI Codex. Claude cannot create images itself, so use this skill whenever the user asks for an image in any wording or language - generate, create, draw, make, design or edit an image, picture, photo, illustration, icon, logo, sprite, texture, mockup, banner, poster, thumbnail or ad creative (Polish - wygeneruj obraz, zrób grafikę, narysuj, stwórz obrazek, ikonę, logo, zdjęcie). Codex makes the image with gpt-image-2 on the user's ChatGPT plan and the files come back into the project. Also use it when the user asks to give a task to Codex, ask or check on Codex, or run work on their Codex quota instead of Claude's. Also use it before you code a new web page, landing page, app screen or visible redesign: it says when to ask the user whether Codex should first draw wireframes, mockups or style directions to pick from. It messages an open Codex window or starts a session, picks a quality tier (draft, standard, high, max) that sets the Codex model and effort, and collects every image, subagents included. When the user asks for it, or a standing preference of theirs says so, it also gets an independent second opinion from Codex on a plan, decision, design or code diff, in addition to Claude's own review and never instead of it.
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

Subagents and saved workflow scripts do not have `${CLAUDE_SKILL_DIR}`. Give them the launcher,
`node ~/.config/co-codex/bin/co-codex.mjs` (`doctor` prints its exact path): it runs the installed
version, so it keeps working after a plugin update. Never write a plugin-cache path with a version
in it into a script. What to paste into their prompt: `references/subagent-brief.md`.

| Command | What it does |
|---|---|
| `list [--all]` | Open sessions (id, status, name, model); `--all` adds saved ones in this project |
| `spawn "<task>" --name <name> [--tier t] [--wait]` | New named session with the task |
| `send <session> "<task>" [--tier t] [--wait]` | Queue a message; it runs after Codex's current turn |
| `wait <session> [--message id]` | Wait for a turn and print its answer (the id `send` prints, else the last queued message, else the latest turn) |
| `read <session> [--turns n]` / `stop <session>` | Print recent answers, interrupt the running turn |
| `images <session> [--turns n] [--out dir]` | List or copy the images of recent turns, subagents included |
| `opinion <text> [--mode challenge]` / `opinion --diff` | Read-only second opinion: a verdict on a plan or decision, or Codex's code review of a diff |
| `cleanup [--older-than 2d] [--name-prefix p] [--yes]` | List old sessions co-codex started here that no window has open; `--yes` deletes them |
| `models` / `limits [--estimate n]` / `doctor` | Tier resolution, quota left and reset times (or the expected share for n images), setup check |
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
   node "${CLAUDE_SKILL_DIR}/scripts/co-codex.mjs" spawn "<brief>" --name img-<short-slug> --tier standard --images --names hero.png,icon.png --sandbox read-only --wait --out <folder> --json
   ```

   Tier: `draft` when the user wants something quick, a sketch, exploration boards or several
   options to pick from; `high` for final, production or print use; `max` only when asked.
   Folder: where the user said, else the project's existing images or assets folder, else
   `./generated-images`. Several images or variants in one request: one session, with the count
   in the brief.
   `--names` lists one file name per image, in the order the brief describes them. Codex ends
   its answer with a `KEEP:` line that says which generation it kept for each name; co-codex
   copies those under the names and every other image of the turn to `<folder>/_rejected/`.
   It never overwrites a different file: a taken name becomes `name-2.png`. With `--replace` the
   name gets the new image and the old file moves to `<folder>/_rejected/<name>-replaced.png`.
3. When it finishes, Read the files in the JSON `names` map, check each against the brief, and
   give the user the paths with one line on what you checked. Say in one line that it used their
   Codex quota. `namesMatchedBy` says how the names were matched:
   - `keep-line`: from Codex's own `KEEP:` line; nothing more to match.
   - `order`: no usable `KEEP:` line, but as many images as names. Check that each file shows
     what its name says.
   - `null`: the files kept their item ids. Match them by eye, as the warning on stderr says.
4. Changes ("make it bluer", "without the text"): send them to the same session with the
   previous file attached:
   `send img-<short-slug> "<change>" --ref <previous file> --images --names <name> --replace --wait --out <folder> --json`.

The JSON gives each image's real `width` and `height`. gpt-image-2 chooses its own output size
whatever the brief asks (seen: 1536x1024 for most landscape images, 1254x1254 square, 1024x1536
portrait, and wide ones such as 1641x958 or 2172x724). When exact pixels matter, resize or crop
the copies afterwards with the project's own tools; co-codex has no image library and does not
resize. When you measure and post-process the images anyway, add `--retries 0` or `1`: the tier's
own checks redo images that are fine, and every redo spends quota. Pixel art: `references/image-briefs.md`.
5. If `doctor` or the command says Codex is missing or signed out, tell the user to install
   Codex (https://developers.openai.com/codex) and run `codex login`.

## Mockups before UI code (ask first)

Before you build a new web page, landing page, app screen or visible redesign in HTML and CSS
(or React, Astro, Tailwind, a CMS theme), you can offer a round of Codex mockups. Picking from
three pictures takes minutes; recoding a finished page in a direction nobody wanted takes longer.

**When to ask**

- Before the first line of UI code, when the layout or the look is still open: no design file,
  screenshot or design system that already settles it.
- Once per page or screen, in one short question with two answers (mockups first, or straight
  to code) that names the cost: a few minutes and some of their Codex quota. For example: "Before
  I code this, should Codex draw 3 versions of the hero and pricing section so you can pick one?
  It takes a few minutes and uses your Codex quota."
- Not for small changes (copy, a bug, spacing, one colour), not when the user gave a design to
  copy or said to go straight to code, and not again after they declined in this conversation.
- Ask from the main conversation. A subagent cannot ask the user, so ask before you hand the UI
  work to one.
- A standing preference decides without asking: when CLAUDE.md, project instructions or memory
  say to always run a mockup round for this kind of work, run it and say in one line which
  preference you followed; when they say never, skip it. The second time the user says yes on
  similar work, offer once to save it as a standing preference, and save it only after a yes.
- A direct request ("make wireframes first", "zrób najpierw makiety") needs no question: run it.

**What to make**

| Still open | Make | Brief template (`references/image-briefs.md`) |
|---|---|---|
| The visual direction, with no references yet | 3-4 style directions | Style directions |
| The structure: sections, order, hierarchy | low-fidelity greyscale wireframes | Wireframes |
| The look of a settled structure | high-fidelity mockups | UI and UX mockups |

**How**

1. Write the brief with the real content: headings and button labels in quotes, brand colours as
   hex, the viewport (desktop 1440x900, mobile 390x844) and the one thing the variants differ in
   (hero layout, section order, density, style). When the page already exists, attach a
   screenshot with `--ref` as a layout reference.
2. Run 2-4 variants on `draft` in a read-only session, with Bash `run_in_background: true`:

   ```
   node "${CLAUDE_SKILL_DIR}/scripts/co-codex.mjs" spawn - --name ui-<page-slug> --tier draft --images --names <page-slug>-1.png,<page-slug>-2.png,<page-slug>-3.png --sandbox read-only --wait --out <folder> --json < brief.md
   ```

   Folder: the project's design or mockups folder, else `./mockups/<page-slug>`. Never a folder
   that gets deployed, such as `public/`, `static/` or `dist/`.
3. Read every PNG, give the user the paths with one line per variant on how it differs, and ask
   which one to build or what to combine. For changes, `send ui-<page-slug> "<change>" --ref
   <chosen file> ...` on the same session. Use `standard` or `high` only when the mockup itself
   will be shown to someone.
4. Build the chosen variant in code. When the page is done, `cleanup --name-prefix ui-` lists
   the mockup sessions to delete.

**Using the mockup**

- It sets the direction, not the spec. Build with the project's design system, semantic HTML and
  accessible contrast.
- Take copy and hex values from the brief, not from the picture. Text in generated images can be
  misspelled, and colours drift.
- Never put a mockup into the page as an image, and never ship the mockup files.

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

## Choosing a sandbox

The sandbox is fixed when a session starts: `send` accepts the session's own `--sandbox` or
`--network` and refuses any other. To change it, spawn a new session. The spawn line and `--json`
show the `sandbox` and whether it has `network` access.

| Task | Sandbox |
|---|---|
| Image generation, questions | `--sandbox read-only` |
| Code edits in this repo or a worktree | `workspace-write` (the default) |
| Installs, builds that download, deploys, Codex Sites, anything online | `--network` (workspace-write with network), or `--sandbox danger-full-access` when the user allows it |

- When the task contains a command such as `npm install`, `git push` or "deploy to" and the
  session has no network, co-codex prints a warning (not for `--images` runs). It does not block;
  decide whether to stop and spawn again.
- Actions that share or publish, such as inviting people or making a site public, can need
  approval, and a spawned session cannot ask for it. Plan for that before a deploy: tell the user
  they may have to approve that step in `codex resume <name> -a on-request`.
- co-codex cannot see which Codex features (such as Sites) an account has. A read-only question
  session gives Codex's own claim about them, which is not verified.

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
own subagents. `--names` does not work with `--subagents`, because each subagent numbers its
images in its own thread. Templates for game art (with pixel-art lessons), UI mockups and ad
creatives: `references/image-briefs.md`.

## Long tasks

1. Run `spawn ... --wait --json` or `send ... --wait --json` with Bash `run_in_background: true`.
   You are notified when it exits; stdout holds the answer. In the foreground the Bash tool stops a
   command after 10 minutes, so add `--timeout 540` there: co-codex exits with code 2 first.
2. Exit 2 means `--timeout` passed while Codex keeps working: run `wait <name>` again, also in
   the background.
3. Sessions live on the Codex daemon, not in your process, so they survive you being restarted.
   Find them with `list --all`, then `wait <name>` for a running turn, `read <name>` for the last
   answer and `images <name> --out <folder>` for its images.

- `send` without `--wait` prints the message id; `wait <session> --message <id>` picks that turn up
  later, even when it was queued behind other work.
- `--out <dir>` copies the turn's images there and logs each in `co-codex-images.jsonl`.
  `--json` returns the answer, model, sandbox, image paths and sizes, refused actions, limit
  status, quota use (`usage`, the windows before and after the run) and `context` (how full the
  session's context is; above 75% use a fresh session for the next batch) as one object.
- Look at the images yourself (Read the PNG) before you report them as done.

## Subagents, workflows and chains of batches

- A subagent or workflow agent does not have this skill. Paste `references/subagent-brief.md` into
  its prompt with the launcher path and the options filled in.
- Batches where a later step needs an earlier result (a design sheet, then its redraws; one area,
  then the next): run them as steps of a workflow, or one after another in the background, and
  pass each step's `--names` files to the next step as `--ref`. Give every step the user's quota
  ceiling as `--max-used`; after exit 4, resend that step once the window has reset. co-codex has
  no queue of its own.
- Parallel runs are fine, one session each. The quota log measures overlapping runs together, so
  they do not count each other's use.

| Exit | Meaning | What to do |
|---|---|---|
| 0 | answered | use the answer |
| 2 | timed out, Codex keeps working | run `wait <session>` again |
| 3 | turn failed or was interrupted | read the error, fix the task, resend |
| 4 | usage limit reached, or a window was above `--max-used` (then nothing was sent) | tell the user the reset time from the message; resend the unfinished part after it |
| 5 | answered, but some actions were refused because they need approval (only in sessions co-codex started; in a window a person holds the declines were theirs, so the exit is 0 with `declined` in the JSON) | tell the user which (`declined` in the JSON, `!` lines on stderr) and ask them to open `codex resume <name> -a on-request` and let Codex retry there, where they approve it. If the retry needs the network, they add `-c sandbox_workspace_write.network_access=true`, or `-s danger-full-access` only if they agree to it |
| 1 | co-codex error | read the message; run `doctor` |

## Rules

- Tell the user each time you send work to Codex. It runs on their ChatGPT plan and spends their
  Codex quota; image generation spends it 3-5x faster than text. Run `limits` before a large batch;
  `limits --estimate <n> --tier <t>` gives the expected share for n images from past runs on this
  machine. After a run, `usage` in the `--json` result already holds the windows, so skip a separate
  `limits` call. When the user or the project sets a quota ceiling, pass it as `--max-used <pct>`
  (or `maxUsedPercent` in the config): co-codex then sends nothing while a window is above it.
- A line starting with `!` means Codex waits for an approval, or lists actions it was refused for
  lack of one. co-codex never approves; ask the user to answer in the Codex window. Never try to
  approve on Codex's behalf.
- Spawned sessions run with approval prompts off, so blocked commands go back to Codex instead of
  waiting. Pick the sandbox from the table above. Use `--sandbox danger-full-access` only when
  the user allows it or their config sets it.
- Codex cannot message you on its own. If it needs something, it ends its turn with a question,
  which arrives as its answer. Reply with another `send`.
- Use one name prefix per batch or project (`img-`, `ui-`, or the project's own), and when a batch
  is checked and delivered, run `cleanup --name-prefix <prefix>` to list its sessions.
- Clean up throwaway sessions once the user no longer needs them: `cleanup --name-prefix img-`
  lists the ones co-codex started in this project that no window has open and nobody used for 2
  days (`--older-than` changes that); add `--yes` to delete them. It never touches sessions
  co-codex did not start, or ones a person has since used in a Codex window. Fallback for one session: `codex delete --force <session uuid>`.

## If it breaks

Run `doctor`. The daemon protocol is marked experimental and Codex updates often; `doctor`
exports the schema of the installed Codex and checks every method co-codex uses. If `codex` is
not on PATH, set `CO_CODEX_BIN` to its full path. More in `references/troubleshooting.md`.
