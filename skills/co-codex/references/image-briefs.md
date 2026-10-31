# Image tasks for Codex

Codex generates images with its built-in tool (gpt-image-2) on the user's ChatGPT plan. co-codex
reads the exact file of every generated image from the turn, subagents included, so you never have
to guess which file in `~/.codex/generated_images` belongs to which task.

## The loop that works

1. **Explore on `draft`.** Ask for several variants, with `--subagents` when there are more than a
   handful. Show them to the user (copy with `--out`, then Read the PNGs).
2. **Finalize on `high`.** Attach the chosen variant with `--ref` as the edit target or style
   reference and describe only what must change.
3. **Check every image yourself** before you call it done: count, layout, transparency, text spelling,
   anything the brief fixed.

```
node "${CLAUDE_SKILL_DIR}/scripts/co-codex.mjs" spawn - --name icons-draft --tier draft --images --subagents --wait --out art/drafts < brief.md
```

## What every image brief needs

- **Subject and use:** what it is and where it will be shown (game HUD, landing page hero, 9:16 story).
- **Format:** aspect ratio or pixel size, and the background ("real transparent background" for alpha).
- **Style:** a short description plus reference images. Name each reference's role: "Image 1 is the
  edit target: keep every figure, pose and position, change only the clothes" or "Image 2 is a style,
  camera and scale reference only".
- **Count and names:** how many images, and the file names if Codex should save them in the project.
- **Fixed text:** every word that must appear, spelled out exactly, in quotes.
- **Done when:** the checks Codex runs before it ends the turn.

## Templates

### Game sprites and sheets

```
Make a sprite sheet for <character>: <n> facings in <rows> rows of <cols>
(top row left to right: S, SW, W, NW; bottom row: N, NE, E, SE), same pose, same scale and
same baseline in every cell, real transparent background, nothing but the sprites.
Style: <pixel art 32 px per tile / painted / low-poly render>; match the attached style reference
(Image 1, style only). Save it as <path>/<name>.png.
Done when: every cell shows the same character at the same size, no cell is empty or cropped.
```

Edit from a finished base instead of generating from scratch when consistency matters: attach the
base sheet as the edit target and change one thing (outfit, colour, weapon). In the game-art run
behind this skill, redressing a finished base sheet kept all eight figures in place. Single bad
frames still happen in long sheets, so check every cell.

### Pixel art

Seen over a week of pixel-art sprite sheets in one project:

- **Size in words does not hold; an anchor does.** Codex ignores "22 pixels tall", but keeps the size
  and place of figures that are already on the image it redraws. A new character takes two turns:
  one sheet for the design, then a redraw on an anchor sheet that has rough figures at the target
  size and place (Image 1, edit target), with the first sheet as the design reference (Image 2).
- **"Make it smaller" shrinks the blocks, not the figure.** A correction turn asking for a smaller
  figure came back with 4 px blocks instead of fewer 8 px ones. Ask for a redraw on an anchor instead.
- **The grid drifts.** Blocks asked for at 8 px come out 7-9 px and drift across a figure, and the
  canvas itself changes size: a square brief of 1024 px came back at 1254 px, which makes the pitch
  8 x 1254 / 1024 = 9.8. Collapse to game pixels on a grid fitted to each figure's colour edges,
  never a fixed grid, and never resample by a non-integer factor (lines double or vanish).
- **Faces get finer blocks** (about 6 px against 8 elsewhere), and a leg can come out a column wider.
  Check eyes and legs first, at the same scale as Codex's original.
- **Edits of a finished sheet keep every figure in place** ("change only the head", "only the held
  items"), so variants can be combined frame by frame: two edits gave four looks.
- **Measure the results yourself.** Codex's own pass or fail on exact sizes, palette and block size
  is too strict: it failed six sheets that were all good after the grid fit. When you post-process
  anyway, pass `--retries 0` or `1`, so the tier does not redo images that are fine.

### UI and UX mockups

```
Make a mockup of the <screen> for <product>, <desktop 1440x900 | mobile 390x844>.
Content: <exact headings, button labels and numbers, in quotes>.
Look: <brand colours as hex>, <type style>, <density>. Follow the attached screenshot (Image 1,
layout reference only) for the navigation.
Make <3> variants that differ in <layout of the hero | card style>. Save them as <path>/<name>-<n>.png.
Done when: every label is spelled exactly as given and nothing is cut off at the edges.
```

A mockup is a picture. Use it to pick a direction, then build the screen in code. When to offer
a mockup round before UI work, and how to use the result: "Mockups before UI code" in `SKILL.md`.

### Wireframes

```
Make a low-fidelity wireframe of the <page> for <product>, <desktop 1440x900 | mobile 390x844>.
Greyscale only: boxes, lines and real text. No photos, no brand colours, no decoration; grey
boxes with a cross stand in for images.
Sections, top to bottom: <hero with "<headline>" and a "<button label>" button>, <...>.
Make <3> variants that differ in <section order | hero layout | navigation>.
Save them as <path>/<name>-<n>.png.
Done when: every section is present, every label is spelled exactly as given, nothing is cut off.
```

### Style directions

```
Make <3> visual directions for the <page> of <product>, one image each, <desktop 1440x900>.
Each shows the hero and one content section in a different style: <1: ...>, <2: ...>, <3: ...>.
Use the same content in all of them: "<headline>", "<button label>".
In your answer, describe each direction in one line: type style, colours as hex, mood.
Save them as <path>/<name>-<n>.png.
Done when: the directions clearly differ from each other and the text is spelled exactly as given.
```

One image holds about one screen (most landscape images come back at 1536x1024), so for a long page
ask for the hero and one or two sections, or one image per section, instead of the whole page in one
picture.

### Ad creatives

```
Make ad creatives for <product> in these sizes: 1080x1080 (1:1), 1080x1350 (4:5),
1080x1920 (9:16). The product must look exactly like the attached photo (Image 1, edit target for
the product only). Headline, exactly: "<headline>". No other text.
Brand colours: <hex>. Mood: <...>. Leave the top <15%> free of important detail for the platform UI.
Make <2> concepts per size. Save as <path>/<concept>-<size>.png.
Done when: the headline is spelled exactly, the product matches the photo, every size is present.
```

### Icon sets

Generate the first icon on `high`, approve it, then pass it with `--ref` as a style reference for the
rest of the set (on `standard`, with `--subagents`). One icon per image keeps edits cheap.

## Batches

- `--subagents` asks Codex to split the batch across its own subagents, one per asset or group.
  Each subagent works on its own files; only the main Codex agent edits shared files such as logs
  or indexes, from their reports.
- A long sequential session fills its context: one art session in the run behind this skill reached
  390k of its 475k tokens. Subagents, or a fresh `spawn` per batch, avoid that. `context` in the
  `--json` result says how full the session is.
- On a Plus plan, about 78 image calls in roughly an hour used up the five-hour limit in that run.
  Run `limits` before a batch, and pass `--max-used <pct>` when the user set a ceiling. If a turn
  ends with exit code 4, co-codex prints the reset time; `images <session> --out <dir>` still
  collects whatever was finished, and you resend the rest after the reset.
- Corrections go to the same session with `--replace`, so the file keeps its name and the earlier
  version moves to `_rejected/`, instead of piling up `name-2.png`, `name-3.png`.
- For batches larger than the plan allows, OpenAI suggests setting `OPENAI_API_KEY`, so image
  calls are billed at API prices instead of the plan's limits
  (https://learn.chatgpt.com/docs/image-generation).
