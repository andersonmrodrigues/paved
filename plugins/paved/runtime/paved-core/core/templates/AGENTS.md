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

Use this flow by default for natural-language development, planning, correction,
debugging and refactoring requests, even when the user does not name Paved. Check
status first and resume the matching run for the same request rather than creating
a duplicate; never reuse an unrelated run. For planning-only requests, stop at the
plan; for investigation-only requests, investigate without implementing a fix.
Implementation requires explicit human approval of the current plan. Answer
repository questions using relevant context without starting a workflow; handle
unrelated conversation normally. Respect explicit user direction.

Do not edit this block by hand; `paved init` and `paved update` maintain it. Write
project-specific instructions for agents outside it.
<!-- paved:end managed -->
