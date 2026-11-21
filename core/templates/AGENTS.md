<!-- paved:begin managed -->
## Paved

This repository uses Paved for agent context, rules and verification.

- Project manifest: `.paved/manifest.yaml`
- Project context: `.paved/project/` (start at `feature-map/`)
- Project rules: `.paved/rules/`
- Verification profile: `.paved/verification/profile.yaml`
- Overrides: `.paved/overrides/overrides.yaml`

Default to direct, outcome-focused work with Paved: load `paved context "<topic or path>"` when project
context helps, keep small changes direct, use `paved task` only for durable handoffs,
and run `paved verify --changed` to validate changed files. For multi-step work, keep
the plan in the task handoff rather than creating extra planning documents.

Use `paved intent`, `paved plan` and `paved execute` only when the user explicitly
requests a governed workflow or a project rule requires one. Planning-only and
investigation-only requests remain read-only. Plan approval is not required for ordinary
implementation; ask a person for product decisions, conflicting rules, irreversible
actions, or persistent verification failures after two distinct fixes. Respect host
permissions and never infer authorization from a plan or autonomy setting.

Do not edit this block by hand; `paved init` and `paved update` maintain it. Write
project-specific instructions for agents outside it.
<!-- paved:end managed -->
