<!-- paved:begin managed -->
## Paved

This repository uses Paved for agent context, rules and verification.

- Project manifest: `.paved/manifest.yaml`
- Project context: `.paved/project/` (start at `feature-map/`)
- Project rules: `.paved/rules/`
- Verification profile: `.paved/verification/profile.yaml`
- Overrides: `.paved/overrides/overrides.yaml`

Route a change request through `paved execute "<request>" --workflow <id> --lane
<trivial|standard|risky> --because "<evidence>" --json`: Paved picks the phases for the
lane, so a trivial change skips planning and a risky one waits for plan approval. Choose
the lane from what you observed, and escalate with `--lane risky` if the change grows.
Answer questions directly or with `paved context "<topic or path>"`; they start no run.
Run `paved verify --changed` to validate changed files, and use `paved task` only for
durable handoffs.

Explicit user direction wins: when the user asks for a plan, only a classification or
no workflow, do that instead; planning-only and investigation-only requests stay
read-only. Ask a person for product decisions, conflicting rules, irreversible actions,
or persistent verification failures after two distinct fixes.
Respect host permissions and never infer authorization from a plan or autonomy setting.

Do not edit this block by hand; `paved init` and `paved update` maintain it. Write
project-specific instructions for agents outside it.
<!-- paved:end managed -->
