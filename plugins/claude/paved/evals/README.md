# Claude skill behavior evals

This suite measures whether the generated Claude plugin selects relevant Paved skills,
avoids unrelated change workflows, and follows Paved's user-facing workflow boundaries.
Cases use synthetic prompts and need no Apecatus or other consumer repository.
The `repository-onboarding` case checks that broad repository-orientation requests activate
`context-discovery` without starting a change workflow.

## Run locally

Build the plugin, copy the exact generated directory to a temporary location, and run the
suite there so Claude's report files never alter generated plugin outputs:

```sh
npm run build:plugin
mkdir -p /tmp/paved-claude-eval
cp -R plugins/claude/paved /tmp/paved-claude-eval/plugin
claude plugin eval /tmp/paved-claude-eval/plugin \
  --runs 3 --max-cost-usd 10 --no-publish --trust-plugin \
  --output-dir /tmp/paved-claude-eval/results \
  --json /tmp/paved-claude-eval/aggregate.json
```

Use `--case <case-name> --runs 1 --ablation none --max-cost-usd 2` for a cheap,
single-case screen. Use the same cases, run count, model and graders when comparing
changes. The default comparison runs both with-plugin and no-plugin arms; positive skill
invocation graders are reported as plugin-fired indicators, while outcome graders provide
the comparable score delta. Each run and each LLM grader uses Claude account or API usage.

`--trust-plugin` skips the initial trust prompt. Use it only for a plugin directory whose
code and eval cases you have inspected. Keep aggregate results, HTML reports, transcripts,
and model usage records outside this source tree; do not commit user data or account data.

The source fixtures in this directory are copied to `plugins/claude/paved/evals/` by
`npm run build:plugin`. They are intentionally not shipped in the portable Codex/Cursor
plugin or the Paved runtime package.
