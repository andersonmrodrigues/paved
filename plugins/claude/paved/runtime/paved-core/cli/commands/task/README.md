# `paved task`

In an initialized project, use `paved task start <slug> "<goal>"` to create
`.paved/tasks/<slug>.md`, `paved task note <slug> "<text>"` to add a mid-flow
note, `paved task resume <slug>` to read it, and `paved task done <slug>
"<summary>"` to complete it. Existing handoffs are never replaced by `start`.

Use `paved verify --task <slug>` to attach the resulting evidence paths and
verification status to an explicitly selected open task. It does not infer a task
when the flag is omitted. Evidence records are not a substitute for checking that
the current changes are covered.
