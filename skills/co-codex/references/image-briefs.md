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

One image holds about one screen (seen up to 1538x1022), so for a long page ask for the hero and
one or two sections, or one image per section, instead of the whole page in one picture.

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
  390k of its 475k tokens. Subagents, or a fresh `spawn` per batch, avoid that.
- On a Plus plan, about 78 image calls in roughly an hour used up the five-hour limit in that run.
  Run `limits` before a batch. If a turn ends with exit code 4, co-codex prints the reset time;
  `images <session> --out <dir>` still collects whatever was finished, and you resend the rest
  after the reset.
- For batches larger than the plan allows, OpenAI suggests setting `OPENAI_API_KEY`, so image
  calls are billed at API prices instead of the plan's limits
  (https://learn.chatgpt.com/docs/image-generation).
