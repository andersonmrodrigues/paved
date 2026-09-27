# Tools generator

## Input

Scripts directories, task-runner definitions, container and compose files, documented
commands.

## Output

Proposed `Tool` documents under `.paved/generated/proposals/tools/`. Tools are
project-owned; a human adopts proposals.

## Preconditions

None beyond a valid manifest.

## Sources analyzed

Script files, task-runner targets, container orchestration files, README command sections.

## Strategy

1. Enumerate scripted operations.
2. Read each to determine inputs, outputs and side effects.
3. Assign the most conservative safety class the evidence allows: anything that deletes,
   resets, migrates, deploys, pushes or targets remote resources is `destructive`.
4. Leave `verification` and `failure` behavior as questions when the script does not
   make them clear.

## Limitations

Side effects hidden in called programs or remote services may be missed; this is why
classification errs toward `destructive`.

## Unknown information

Unclear side effects, prerequisites or failure behavior are recorded as questions in the
proposal, and the tool is classified `destructive` until a human decides otherwise.

## Avoiding invention

Only scripted or documented operations are proposed. Inputs and outputs come from the
script, not from what such a script would typically take.

## Change detection

Source hashes of scripts and task definitions.
