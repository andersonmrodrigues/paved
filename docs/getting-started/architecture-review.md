# Architecture review

What the architecture and Core design pass defined, which decisions it made, what it left
open, and what should be built next. Paved is **not** production ready: the architecture
is specified and partly enforced by tests in this repository, but no CLI, generator or
runner exists, and nothing has been used on a real consumer repository.

## Starting point

The [bootstrap](bootstrap-review.md) had produced layers, schemas, Core content and
contracts, but several questions were answered only in prose or not at all: what may
depend on what, how inherited content is modified, what happens when the Core changes
under an override, how an agent's claims differ from observations, and how a generated
statement is traced back to its source.

## Research that shaped the design

| Source | What Paved took from it |
|---|---|
| [SLSA provenance](https://slsa.dev/spec/v1.0/provenance) | Provenance is trusted as far as the platform that produced it, not the tenant. Became the recorder levels `agent < paved < ci` |
| [in-toto attestations](https://github.com/in-toto/attestation) | An attestation is about a subject identified by digest. Became evidence bound to `change.revision`, with mismatches rejected |
| [Kubernetes API deprecation policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/) | Within an API version, no field removal and no change of meaning; deprecation windows. Became the `apiVersion` rules |
| [Kustomize](https://kubectl.docs.kubernetes.io/references/kustomize/) | Showed the cost of arbitrary patches. Paved chose typed override operations instead |
| [Nx module boundaries](https://nx.dev/features/enforce-module-boundaries) | Tag-based dependency constraints. Became the `components` model enforced by a test, without adopting the tool |
| [agents.md](https://agents.md/) | Plain Markdown, repository-local, nearest file wins. Kept as the entry mechanism |
| [Agent Skills](https://agentskills.io/specification) | Frontmatter restrictions. Kept `SKILL.md` + `skill.yaml` |

## What was created or changed

- **Architecture docs** (`docs/concepts/`): [architecture](../concepts/architecture.md)
  (rewritten, with Mermaid diagrams and a definition of every concept),
  [boundaries](../concepts/boundaries.md), [inheritance](../concepts/inheritance.md),
  [context loading](../concepts/context-loading.md), [verification](../concepts/verification.md),
  [traceability](../concepts/traceability.md), [multi-repository](../concepts/multi-repository.md)
  (renamed and extended), [failure handling](../concepts/failure-handling.md),
  [gardener](../concepts/gardener.md), [extensibility](../concepts/extensibility.md);
  [versioning](../concepts/versioning.md), [repository lifecycle](../concepts/repository-lifecycle.md)
  and [ownership](../concepts/ownership-and-regeneration.md) extended.
- **Eleven ADRs** in [docs/decisions](../decisions/README.md).
- **Schemas:** new `Lock` and `ContextDocument` kinds; identified provenance sources and
  `conflicts`; evidence observation metadata; typed override operations with digests;
  `policy.minimum_recorder`; `components` and `required`/`schema` on the consumer layout.
- **Library:** evidence assessment now rejects observations from another revision.
- **Core content:** loading tiers, knowledge states and evidence trust in the agent
  instructions; principle 11; the *overrides need review* state; READMEs aligned with the
  override model; a `context-document.md` template.
- **Tests:** a boundaries test, layout and template-frontmatter tests, generator/layout
  schema consistency, override template coverage, and new fixtures. 154 tests pass.
- **Maintenance:** an [enforcement candidates](../maintenance/enforcement-candidates.md)
  list separating what is enforced from what is planned.

## Major decisions

| Decision | ADR |
|---|---|
| Core holds only what is true for every repository; project knowledge stays in the project | [0001](../decisions/0001-core-vs-project-context.md) |
| Adapters only add; they cannot modify the Core or add workflows | [0002](../decisions/0002-adapter-architecture.md) |
| Fixed composition order, no shadowing, typed overrides with digests; `workflows.disabled` moved into overrides | [0003](../decisions/0003-composition-and-overrides.md) |
| Ownership per path; generators write only generated or disposable paths | [0004](../decisions/0004-generated-vs-human-owned.md) |
| Claims, observations and assessment are separate roles | [0005](../decisions/0005-verification-evidence-separation.md) |
| Independent versions; Project Context, overrides and generated data versioned by reference | [0006](../decisions/0006-versioning-boundaries.md) |
| Knowledge states; STALE computed, never stored; per-block citations | [0009](../decisions/0009-knowledge-states-and-provenance.md) |
| Machine-readable component graph enforced by a test | [0010](../decisions/0010-machine-readable-dependency-model.md) |
| Fail explicitly, toward the stricter behavior (principle 11) | [failure handling](../concepts/failure-handling.md) |

## The models in one paragraph each

**Dependency model.** `schemas ← core ← generators` form the distributed Core release;
`adapters` depend on `schemas` and `core`; `cli` on all of those; `docs` and `tests` on
everything. Nothing depends on a consumer. Enforced by `tests/core/boundaries.test.ts`.

**Ownership model.** Five ownership values on every consumer path. Only
`.paved/manifest.yaml` is required. Generators cannot write human- or project-owned
paths; they propose. The artifact table is in [ownership and regeneration](../concepts/ownership-and-regeneration.md).

**Inheritance model.** Core → adapters → project → overrides. Layers add; only overrides
modify, with six typed operations and a reason. Identities never collide, so the only
precedence rule is "an override beats its default". Overrides whose target changed stop
relaxing it until a human re-confirms them.

**Versioning model.** Core SemVer, `apiVersion`, adapter SemVer, generator versions;
everything else by reference. A change that can make a compliant consumer
non-compliant is breaking, even without a schema change.

**Multi-repository model.** Pull-based: each repository declares ranges, locks exact
versions and digests, and updates on its own schedule. No copies, no central service at
runtime, no cross-repository context.

**Verification model.** The agent claims; the agent, runner or CI observes, bound to a
revision; deterministic code assesses; humans approve gates. Evidence answers what, how,
by whom, when, against which revision, with what tool and result.

## Validation of this pass

| Check | Result |
|---|---|
| Every concept has a "what is" definition | Yes, in [architecture](../concepts/architecture.md) |
| Boundaries of every component, with allowed and forbidden dependencies | Yes, machine-readable and tested |
| No dependency cycles | Tested |
| Consumer contract (mandatory, optional, generated, human-owned, inherited, extendable, regenerable) | Yes, in [boundaries](../concepts/boundaries.md#the-consumer-boundary) and the manifest |
| Ownership of every artifact | Yes, table in ownership and regeneration |
| Every inheritance question answered, precedence deterministic | Yes, in [inheritance](../concepts/inheritance.md) |
| Versioning of each versioned thing; compatible vs breaking; migration, regeneration, validation failure | Yes, in [versioning](../concepts/versioning.md) |
| Context-loading tiers | Yes; in the agent instructions and [context loading](../concepts/context-loading.md) |
| Source-of-truth hierarchy and knowledge states | Yes, in [traceability](../concepts/traceability.md); states in schemas |
| Claims separated from observations | Yes; in schema and library |
| Gardener signals and enforcement order | Yes, in [gardener](../concepts/gardener.md) |
| Extension points without a plugin system | Yes, in [extensibility](../concepts/extensibility.md) |
| Failure boundaries | Yes, in [failure handling](../concepts/failure-handling.md) |
| No domain knowledge in distributed content | Keyword scan clean; semantic check is review-only |
| `npm run check` | Strict type check and 154 tests pass |

Inconsistencies found and fixed during the pass:

- Two places could disable a workflow (the manifest and overrides). Consolidated into overrides.
- Overrides implicitly meant "extend"; now every entry has an explicit `action`.
- Evidence artifacts could omit who recorded them, unlike checks. Now required.
- Markdown context documents had no schema for their frontmatter, and docs referred to an undefined `paved` frontmatter key. Now `ContextDocument`.
- Generator outputs and the consumer layout could disagree on a path's schema. Now tested.

## Unresolved decisions

1. **Distribution channel** for the Core and adapters (package, archive, Git tag). It
   decides the `source` format in the lock and how `paved update` resolves.
2. **Adapter repository model:** in this repository with independent versions, or
   separate repositories.
3. **Organization layer:** shared conventions between adapters and projects. Today an
   adapter-shaped package; a real layer would need its own id prefix and precedence.
4. **Cross-repository knowledge** (service maps, shared contracts). Deliberately out of
   scope for `paved/v1`.
5. **Durable evidence:** attached to PRs, CI artifacts, or both; and an approval record
   format for human gates.
6. **Freshness thresholds:** how old an adapter `reviewed_at` or a context
   `source_revision` may be before tooling warns.
7. **Review workflow** for generated context and whether generation state is committed.
8. **Whether adapters may contribute workflows** in a later API version.
9. **CLI distribution and exit codes**, provisional until implemented.

## Assumptions

- Consumers use Git, and revisions identify what was tested.
- A repository has at least one human owner who reviews context and overrides.
- Agents follow Markdown instructions reasonably well; enforcement does not depend on it,
  but usefulness does.
- Hash-based freshness is good enough; semantic staleness (the code changed meaning
  without the cited lines changing) is not detected.

## Future implementation work

In order of enforcement gained per unit of work:

1. **`paved doctor`:** schema validation of `.paved/`, composition checks (collisions,
   missing targets, non-overridable targets, duplicate overrides), override digests,
   lock digests.
2. **`paved verify --evidence`:** the existing library plus `minimum_recorder`.
3. **Distribution + `paved init`/`update`** with the lock file and override review.
4. **A runner** that executes profile checks and records them as `paved`, and a CI
   integration that records them as `ci`.
5. **Deterministic generators** (`verification`, `feature-map`) with the merge strategy
   and managed blocks.
6. **One language and one framework adapter** from official sources.
7. **A pilot consumer**, with every friction recorded as a Gardener input.
8. **Gardener aggregation** across evidence and overrides.
9. **CI for this repository** running `npm run check`.

## Limitations

- Composition, drift detection, freshness and the runner are specified, not built. The
  tables in [enforcement candidates](../maintenance/enforcement-candidates.md) say which
  guarantees exist today.
- The architecture has not met a real repository. Expect contracts to change when it does.
- This directory is still not a Git repository.
