# Workflow fragments

Reusable Core workflow guidance lives in `<name>/FRAGMENT.md` next to `fragment.yaml`,
validated as `WorkflowFragment`. Metadata declares a `core.fragment.<name>` id, inputs,
skill references and tool references. Start with the workflow fragment templates in
`core/templates/`.

The body may interpolate only declared input ids as `{{ inputs.<id> }}`. Fragments
reuse guidance while preserving workflow gates, approval requirements and tool safety.
