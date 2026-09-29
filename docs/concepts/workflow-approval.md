# Workflow approval and safe autonomy

Agents act on their own where mistakes are cheap to detect and undo, and stop for a
person where they are not. Workflows make those stopping points explicit as **gates with
`approval`**.

## Gates

```yaml
gates:
  - id: mitigation-approved
    condition: A human responsible for the affected system approved the mitigation.
    approval: production-change
  - id: breaking-change-accepted
    when: The release contains incompatible changes.
    condition: A human accepted releasing the incompatible changes.
    approval: breaking-change
```

- A gate without `approval` is checked by the agent and recorded as `passed`.
- A gate with `approval` is satisfied only by a human decision recorded as `approved`,
  with `decided_by` (never `agent`, `paved` or `ci`) and `decided_at`. `passed` does not
  satisfy it (`assessRun`).
- A gate with `when` applies only when that condition holds; otherwise it is recorded as
  `not-applicable` with the reason. An unconditional gate can never be not applicable.
- Projects add gates through overrides (`extend` with `add_gates`); they cannot remove
  Core gates.

## Approval categories

| Category | Asked for | Core use |
|---|---|---|
| `destructive-operation` | Data loss or effects that cannot be undone | Any phase reaching a destructive tool |
| `production-change` | A change to a running shared or production system | Incident mitigation |
| `release` | Publishing to users | Release completion |
| `security-exception` | Accepting a deviation from a security rule | Project overrides |
| `architecture-exception` | Accepting a deviation from an architecture rule | Feature planning (conditional) |
| `breaking-change` | An incompatible change for consumers | Release planning (conditional) |
| `risk-acceptance` | Going ahead despite a known, unmitigated risk | Refactor without a test net (conditional) |

The spec's "high-risk change" is `risk-acceptance`; a "breaking migration" is
`breaking-change`; a "production deployment" is `release` or `production-change`.

## Safe autonomy

| Level | Examples | Allowed |
|---|---|---|
| Read-only | Reading code, `core.repository.diff`, `core.repository.history` | Autonomously |
| Safe mutation | Editing files in the working tree, running local checks | Autonomously; reversible by the version control system |
| Destructive | Deleting data, rewriting history, changing remote state | Only with the tool's own confirmation **and** an approval gate in the phase |
| High-impact | Anything in the categories above | Only after the approval gate |

The levels come from the tool contract's `safety` class (`read-only`, `safe-mutation`,
`destructive`; a destructive tool must require confirmation). Workflows do not relax
them: `assessWorkflowQuality` rejects a phase that can reach a destructive tool, directly
or through its skills, without an approval gate or with automatic retry. Change types
that act on shared systems must carry their approval somewhere: `release` needs
`release`, `incident` needs `production-change`.

## What an approval covers

An approval covers what was shown when it was requested: the plan, the diff, the
evidence so far. If the change grows after approval, the gate is requested again. Paved
records who approved; it does not verify identity. Until a runner exists, the record is
as trustworthy as the process that writes it, which is why CI and reviewers should see
the run record next to the evidence.

## Conversational decision channels

Not every project choice is a workflow approval gate. Material decisions use one of two
channels selected by the registered handler's effect:

| Channel | Evidence of consent | What it does not prove |
|---|---|---|
| `relayed` | The answer and user-supplied `--answered-by` identity are recorded with the decision | Paved does not authenticate the person or treat an agent-selected recommendation as consent |
| `human-authored` | A person-authored `.paved/approvals/<decision-id>.json` matches the exact decision digest and answer | The agent must not create that file, and Paved does not authenticate the writer |

Additive configuration and lock transactions can use relayed answers. Repository-mutating
or destructive effects require the human-authored channel. A plan approval remains its
own run gate bound to the plan digest. The channels explain who must author the response;
they do not change tool safety classes or let a decision override a blocking diagnostic.
See [conversational decisions](decisions.md).
