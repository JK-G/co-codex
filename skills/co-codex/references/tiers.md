# Quality tiers

A tier is a preset of Codex model and reasoning effort, plus quality rules that `--images` adds to
the message. Models are tried in order against the models the account offers right now
(`model/list`), so a tier keeps working when OpenAI renames or retires a model.

## Defaults (October 2026)

| Tier | Models tried in order | Effort | Image rules added by `--images` |
|---|---|---|---|
| `draft` | gpt-6-luna, gpt-5.6-luna | medium | one attempt per image, smallest size that shows the idea, no regenerating unless unusable |
| `standard` | gpt-6.1-sol, gpt-6-sol, gpt-5.6-sol | medium | check each result once with view_image, regenerate at most once on a clear miss |
| `high` | gpt-6.1-sol, gpt-6-sol, gpt-5.6-sol | high | full size and detail, check every point of the brief, up to 2 regenerations, report what still deviates |
| `max` | gpt-6-astra, gpt-6.1-sol, gpt-6-sol | high | 2 variants per image, keep the better, up to 3 regenerations |

If the model does not support the tier's effort, the strongest supported effort below it is used.

## What a tier changes, and what it does not

Codex's built-in image tool always uses gpt-image-2. The agent model decides how well the image
prompt is written, how carefully the result is checked against the brief and how often it is
redone. In a test on 2026-10-16 a `draft` session on gpt-6-luna still produced a 1254x1254 image:
asking for "the smallest size" did not shrink the output. Of about 300 logged images, most
landscape ones came back at 1536x1024, square ones at 1254x1254 and portrait ones at 1024x1536,
with a few wide sizes such as 1641x958 and 2172x724. So a cheaper tier saves agent tokens and
retries, not image resolution.

`--retries <0-3>` replaces the tier's regeneration rule for one run, without changing its model
or effort. Use `0` or `1` when the caller measures and post-processes the images anyway: on `high`,
Codex's own checks redo images whose size or grid it judges wrong, although the fix comes after
the run. co-codex also tells Codex, on every tier, not to regenerate an image only for its pixel
size.

On any tier the output size does not follow the brief: a brief that asked for 1080x1080 got
1254x1254. co-codex reads each PNG's real `width` and `height` and puts them in the JSON results
and in `co-codex-images.jsonl`. When exact pixels matter, resize or crop the copies afterwards
with the project's own tools.

## Cost, from OpenAI's pricing page

Credits per 1M tokens at standard speed (https://learn.chatgpt.com/docs/pricing, read 2026-10-16):

| Model | Input | Cached input | Output | Plus: local messages per 5 h |
|---|---|---|---|---|
| gpt-6-astra | 250 | 25 | 1,250 | 5-45 |
| gpt-6.1-sol | 50 | 2.5 | 250 | 15-160 |
| gpt-6-sol | 50 | 5 | 250 | 15-150 |
| gpt-6-luna | 2.5 | 0.25 | 12.5 | 350-3,000 |

- Per token, luna costs 1/20 of sol, and astra costs 5x sol.
- Image generations use included limits about 3-5x faster than similar turns without images,
  depending on image quality and size (same page).
- Pro plans had no five-hour limit when this was written; Plus and Business do.

## Speed and subagents

- `spawn --fast` passes `serviceTier: "fast"`. OpenAI documents fast mode as using included
  limits 2.5x faster (https://learn.chatgpt.com/docs/agent-configuration/speed.md).
- Reasoning effort `ultra` (sol and astra, not luna) makes Codex use subagents on its own for
  parallel work. `--subagents` asks for the same in plain words on any tier and is cheaper to
  control: Codex picks the subagents' model and effort, which you can name in the task.

## Your own tiers

Override or add tiers in `~/.config/co-codex/config.json` (all projects) or `.co-codex.json` in a
project. Only the fields you give change:

```json
{
  "defaultTier": "standard",
  "tiers": {
    "draft": { "effort": "low" },
    "review": { "about": "second opinion on a diff", "models": ["gpt-6.1-sol"], "effort": "xhigh" },
    "art": {
      "about": "assets that are measured and fitted afterwards",
      "models": ["gpt-6.1-sol"], "effort": "high",
      "imageNote": "Full detail. Check each image once against the brief and regenerate at most once, only on a clear miss. Do not judge exact pixel sizes or grids: they are measured afterwards."
    }
  },
  "maxUsedPercent": 85
}
```

`maxUsedPercent` makes `spawn`, `send` and `opinion` send nothing while the 5-hour or weekly window
is above that share; `--max-used` overrides it for one run.

See `templates/co-codex.config.json` for every setting.
