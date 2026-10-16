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
asking for "the smallest size" did not shrink the output. Earlier runs gave 1254x1254 for square
and 1538x1022 for landscape images. So a cheaper tier saves agent tokens and retries, not
image resolution.

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
    "review": { "about": "second opinion on a diff", "models": ["gpt-6.1-sol"], "effort": "xhigh" }
  }
}
```

See `templates/co-codex.config.json` for every setting.
