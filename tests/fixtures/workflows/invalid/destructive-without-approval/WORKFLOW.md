# Sample

## When to use

Configuration changes that alter no code path. It may call `project.data.purge`.

## Phases

- **implementation:** keep each setting change small enough to revert on its own.

## Escalation

Stop and ask when a setting has no documented owner.
