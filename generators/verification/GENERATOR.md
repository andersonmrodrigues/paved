# Verification generator

## Input

Build and task-runner definitions, CI workflow files, test directories, documented
commands; adapter `check_suggestions`; the existing verification profile.

## Output

A proposed `VerificationProfile` under `.paved/generated/proposals/verification/profile.yaml`,
plus a diff against `.paved/verification/profile.yaml` if one exists. The profile itself
is project-owned; a human adopts the proposal.

## Preconditions

Adapters confirmed in the manifest.

## Sources analyzed

Build files and task definitions, CI configuration, scripts, test directory layout,
README and contribution guides.

## Strategy

1. Collect commands the repository already runs, preferring CI (what actually gates
   merges) over documentation.
2. Classify each by check type using adapter knowledge.
3. Add adapter suggestions only for check types with no existing command.
4. Where possible, run each proposed command once and record whether it succeeded.

## Limitations

CI steps that need secrets or infrastructure cannot be run locally. Classification of
custom scripts may be wrong.

## Unknown information

Check types with no command are proposed under `unavailable` with reason "not found";
a human confirms or supplies the command.

## Avoiding invention

No command is proposed that does not appear in the repository or an adapter suggestion,
and suggestions are labeled as such.

## Change detection

Source hashes of build and CI files; changes to the adapter set.
