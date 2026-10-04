<!-- paved:begin managed -->
## Paved

This repository uses Paved for agent context, rules and verification.

- Project manifest: `.paved/manifest.yaml`
- Project context: `.paved/project/` (start at `feature-map/`)
- Project rules: `.paved/rules/`
- Verification profile: `.paved/verification/profile.yaml`
- Overrides: `.paved/overrides/overrides.yaml`

Change code through Paved: `/paved:intent` with the request, then `/paved:plan` and
`/paved:execute`, so project rules and verification apply. `/paved:status` shows the
project state and what is available.

Do not edit this block by hand; `paved init` and `paved update` maintain it. Write
project-specific instructions for agents outside it.
<!-- paved:end managed -->
