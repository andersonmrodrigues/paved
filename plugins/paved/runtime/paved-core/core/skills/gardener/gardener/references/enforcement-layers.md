# Enforcement layers

The Gardener places each fix at the strongest layer that can hold it. Stronger layers
catch mistakes earlier, need no one to remember them, and apply to humans and agents alike.

```text
Agent mistake ──► Human correction ──► Recurring? ──no──► record the incident, stop
                                           │ yes
                                           ▼
                                   Gardener proposal
                                           │
                    try each layer in order; stop at the first that works
                                           ▼
 1 Architecture ─ 2 Static analysis ─ 3 CI ─ 4 Rule ─ 5 Skill ─ 6 Documentation
                                           │
                                           ▼
                           Human approves ──► change is made ──► verified
```

| # | Layer | Examples | Works when | Cost of being wrong |
|---|---|---|---|---|
| 1 | Architecture / data structures | Make the invalid state unrepresentable; a single module owns the concern; remove the second way of doing it | The mistake is possible only because the design allows it | Largest change; do it deliberately |
| 2 | Static analysis / compiler | Types, lint rules, architecture tests, schema validation | The mistake has a syntactic or structural signature | False positives annoy everyone |
| 3 | CI / automated checks | Required checks, contract tests, budgets | The mistake shows up when the code runs | Slower feedback than static analysis |
| 4 | Rule | A Paved rule with scope, severity and verification | Judgement is needed but the constraint is statable | Relies on agents and reviewers reading it |
| 5 | Skill | A step in a Core or project skill, or an addendum | The mistake is about process or order of work | Only applies when the skill is used |
| 6 | Documentation | Project Context, READMEs | Missing knowledge, not missing constraint | Easiest to ignore |

## Choosing the owner

| Owner | Put the fix here when | Where |
|---|---|---|
| Core | It holds for every repository regardless of domain and technology | Core repository, via a change reviewed by Core maintainers |
| Adapter | It holds for every repository using a technology | `adapters/<category>/<name>/` |
| Project | Anything else | `.paved/` in the project, or the project's code and CI |

## Promotion

Rules record `enforcement.layer`. A rule at layer `rule`, `skill` or `documentation` that
keeps being violated is a promotion candidate: ask again whether static analysis or CI
could enforce it. Promotion changes the rule's `enforcement` and adds the check to the
project's verification profile.

## What the Gardener does not do

- It does not apply structural changes without human approval.
- It does not delete rules, skills or context; it proposes retirement with a reason.
- It does not act on a single incident.
