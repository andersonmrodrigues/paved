<!-- paved:begin managed -->
## Paved

This repository uses Paved for agent context, rules and verification.

- Project manifest: `.paved/manifest.yaml`
- Project context: `.paved/project/` (start at `feature-map/`)
- Project rules: `.paved/rules/`
- Verification profile: `.paved/verification/profile.yaml`
- Overrides: `.paved/overrides/overrides.yaml`

Change code through the Paved commands (`/paved:feature`, `/paved:fix`,
`/paved:refactor`, `/paved:verify`; `/paved:status` shows what is available) so project
rules and verification apply.

Do not edit this block by hand; `paved init` maintains it. Write project-specific
instructions for agents outside it.
<!-- paved:end managed -->
