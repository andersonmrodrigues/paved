<!-- paved:begin managed -->
## Paved

This repository uses Paved for agent context, rules and verification.

- Start with the Core instructions: `.paved/generated/core/core/instructions/AGENTS.md`
  (resolved Core cache; run `paved update` if it is missing).
- Project manifest: `.paved/manifest.yaml`
- Project context: `.paved/project/` (start at `feature-map/`)
- Project rules: `.paved/rules/`
- Verification profile: `.paved/verification/profile.yaml`
- Overrides: `.paved/overrides/overrides.yaml`

Do not edit this block by hand; `paved init` and `paved update` maintain it. Write
project-specific instructions for agents outside it.
<!-- paved:end managed -->
