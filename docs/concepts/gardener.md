# Gardener

The Gardener is Paved's feedback loop: it notices where the paved path is failing and
proposes a structural fix. The procedure an agent follows is the `gardener` skill
(`core/skills/gardener/gardener/SKILL.md`); this document describes the architecture
around it.

## Signals

Each signal is something Paved already records. The Gardener reads records; it does not
rely on anyone's impression.

| Signal | Source | Suggests |
|---|---|---|
| The same human correction twice | Review comments, evidence `rules` notes, incident reports | A missing rule, skill step or check |
| A rule repeatedly `violated` or overridden | Evidence records; overrides with reasons | The rule is wrong, too broad, or weakly enforced |
| The same Core rule relaxed in many repositories | Overrides across consumers | The Core rule is wrong for a class of repositories |
| Recurring gaps for a check type | Evidence `gaps` | The project lacks a check it keeps needing |
| Claims supported only by `agent` recordings | Evidence `recorded_by` | Checks should move into the runner or CI |
| Stale or conflicting context | Source hashes; `conflicts` | Context needs regeneration or a human decision |
| Many `unknowns` on the same topic | Context documents | Missing documentation or an owner to ask |
| Overrides flagged *needs review* | `target_sha256` mismatch | The exception may no longer be needed |
| Tool implementation unavailable, incompatible or ambiguous | Tool resolution result | An adapter/project binding is missing, stale or duplicated |
| Repeated Tool failures or malformed outputs | Sanitized Tool execution records and evidence | A capability contract, implementation or environment needs repair |
| Unsafe or overly broad Tool policy | Tool contract and override records | Restrict the policy or add a stronger permission/approval boundary |
| Rules at layer `rule`, `skill` or `documentation` | `enforcement.layer` | Promotion to a stronger layer |

## Enforcement order

Every proposal tries the layers in this order and stops at the first that can hold the
fix:

```text
1 Architecture → 2 Static analysis → 3 CI → 4 Rule → 5 Skill → 6 Documentation
```

A stronger layer catches the mistake earlier, needs nobody to remember it, and applies
to humans and agents alike. A proposal that settles on a weaker layer says why the
stronger ones do not work. The detailed table is in the skill's
`references/enforcement-layers.md`.

## Ownership of the fix

| Where it holds | Owner | Where the change goes |
|---|---|---|
| Every repository | Core | A Core change, reviewed by Core maintainers |
| Every repository using a technology | Adapter | The adapter |
| This repository | The project | Its code, CI or `.paved/` |

Most fixes belong to the project. A Core change needs evidence from more than one
repository.

## Boundaries

- The Gardener **proposes; humans decide.** It never edits rules, skills, the Core or
  project architecture on its own.
- It needs at least two concrete incidents. One incident is recorded, not generalized.
- Its proposals are evidence-backed like any change: they name a check that would have
  caught the original incidents.

## Not yet built

Signals are recorded today, but nothing aggregates them. A future `paved garden`
command (or a CI job) could scan evidence and overrides and open proposals. That is
listed as future work in the [architecture review](../getting-started/architecture-review.md).
