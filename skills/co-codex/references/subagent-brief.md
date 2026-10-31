# Brief for subagents and workflow agents

A subagent or a workflow agent does not have the co-codex skill loaded and does not know
`${CLAUDE_SKILL_DIR}`. Paste the block below into its prompt, with the parts in `<...>` filled in,
so it runs co-codex without reading `help` or the skill first.

```
Images come from OpenAI Codex through co-codex. Run it only as:
  node "<launcher path>" <command> [options]
(<launcher path> is what `doctor` prints as "launcher", for example ~/.config/co-codex/bin/co-codex.mjs.
It runs the installed co-codex, so never replace it with a path from the plugin cache.)

New images:
  node "<launcher path>" spawn - --name <prefix>-<slug> --tier <tier> --images --names <a.png,b.png> \
    --sandbox read-only --wait --out <folder> --json --max-used <pct> [--retries <0|1>] [--ref <file>]... < brief.md
Changes to an image from an earlier run, in the same session:
  node "<launcher path>" send <prefix>-<slug> - --ref <kept file> --images --names <a.png> --replace \
    --wait --out <folder> --json --max-used <pct> < change.md

- Run with Bash run_in_background: true. In the foreground add --timeout 540 (the Bash tool stops at 10 minutes).
- The JSON "names" maps each requested name to its file. Read every PNG before you report it as done.
- Exit codes: 0 done; 2 timed out, Codex keeps working: run `wait <session> --out <folder> --names <list> --json`;
  3 the turn failed: read "error", fix the brief, resend (after a "not loaded" note, spawn a new session
  with the last kept image as --ref); 4 usage limit, or above --max-used: send nothing more, report the
  reset time; 1 a co-codex error: report the message.
- "usage" in the JSON has the quota windows after the run: no separate `limits` call needed.
- "context.percent" above 75: start a new session for the next batch.
```

Fill in:

- `<launcher path>`: from `doctor`.
- `<prefix>`: one per batch (`img-`, `ui-`, or the project's own), so `cleanup --name-prefix <prefix>`
  finds the sessions afterwards.
- `<tier>`: as in `SKILL.md` ("Choosing a tier").
- `--max-used <pct>`: the quota ceiling the user or the project set. Leave it out when there is none.
- `--retries 0` or `1` when the caller measures and post-processes the images anyway (pixel art,
  exact sizes): the tier's own checks would redo images that are fine.
