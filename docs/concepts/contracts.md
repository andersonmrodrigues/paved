# Contracts

What each Paved document promises, and which of those promises a machine checks. The
schema files are the normative definition of structure; this page explains intent and
the rules that span fields or documents. Catalog and validation layers:
[schemas](schemas.md). Reference formats: [references](references.md).

## Manifest (`Core`, `Project`)

The entry point of a repository. The **Core manifest** declares the Core version, the API
versions it reads, the schema for every document kind, the component graph and the
consumer layout with its ownership model. The **project manifest** declares the project
name, optional `owners`, the Core range it accepts and the adapters it selects.

The project manifest deliberately does not describe the project's technology, context,
capabilities or overrides. Each of those has a source of truth elsewhere (the code and
adapter detection, `.paved/project/`, the skills in the effective set,
`.paved/overrides/`); a copy in the manifest would drift.

## Skill

`skill.yaml` is the checkable half of a skill; `SKILL.md` is the procedure, with
frontmatter exactly as the Agent Skills specification defines. The contract names the
skill's qualified `id`, `version` and `status` (with a migration note when deprecated),
its category, the context areas it needs, the tools (required and optional) and rules
it uses, the skills it hands work to, the check types that must and should verify its
work, the evidence it must produce and its supporting files. Full contract:
[skills](skills.md).

## Workflow

One class of change from request to completion: its trigger (`change_type`), `version`
and `status`, inputs, context, preconditions and rules, then the phases in canonical
order, each with a goal, skills, tools, required and recommended check types, gates
(conditional with `when`, human decisions with `approval`), `skip_when` and `retry`. It
must contain `verification`, `evidence` and `completion` phases, which cannot be skipped,
and declares the evidence kinds, outputs and completion criteria a run must meet. It
references skills, tools, rules and check types by id; it never repeats their content.
Full contract: [workflows](workflows.md).

## WorkflowRun

The state of one workflow run: inputs, each phase's status, attempts, skills and gates,
the failure (code, phase, reason, retry class, next action), warnings, outputs, the
evidence path and an append-only event log. A record, not an engine:
[workflow state](workflow-state.md).

## Rule

One constraint with a rationale, scope (`applies_to` paths, workflows, change types,
adapters), enforcement mechanism and severity:

| Severity | Meaning |
|---|---|
| `error` | Blocking. A `complete` evidence record cannot contain a violated `error` rule |
| `warning` | Must be reported; does not block completion |
| `info` | Guidance; reported when relevant |

`overridable: false` protects rules a project must not relax (secrets, evidence,
boundaries, unknowns).

## Tool and ToolImplementation

A Tool is a versioned capability contract; it does not contain a command. It declares
typed inputs and outputs, preconditions, required permissions, allowed environments,
side effects, idempotency, bounded timeout/retry behavior, error vocabulary, safety and
evidence capture. A separate `ToolImplementation` binds the capability to an executable
mechanism supplied by Core, an adapter or a project. The binding must match the Tool
version range and environment and cannot redefine the capability's meaning.

| Safety | Constraint |
|---|---|
| `read-only` | No side effects (schema: `side_effects` is empty) |
| `safe-mutation` | Bounded, reversible local mutation; only controlled environments by default |
| `destructive` | Explicit human approval per invocation; no automatic retry |
| `high-impact` | Explicit human approval per invocation for consequential external effects |

Discovery does not grant permission. Policy checks happen before resolution/execution;
unknown permissions and unavailable bindings fail closed. Executable bindings use argv
elements, not shell interpolation. A Tool execution may be translated to a Verification
result only after output and provenance metadata validate; the existing Evidence
assessor still controls completion. Tool definitions have no credential field, and their
closed schema rejects unknown fields. Implementations must obtain secrets through a
protected runtime mechanism and sanitize captured output.

## Verification profile

What *can* be checked in this project: the ids of available Check definitions, the
types unavailable (and why), and the policy (`minimum_recorder`). Each Check names a
Tool capability; implementation resolution is a separate, explicit step. Workflows and
skills name check types.

## Evidence

What *was* observed for one change. Claims are assertions; checks and artifacts are
observations, each with who recorded it, against which revision and with which result.

- Check status: `passed`, `failed`, `error`, `blocked`, `inconclusive`, `skipped`. Only `passed`
  supports a claim.
- Artifact recorder: `agent`, `human`, `paved`, `ci`. Review and manual observation
  (`self_reportable: false` in the registry) support nothing when the agent records
  them: an agent describing its own work is an assertion, not evidence.
- `change.revision` is required; every observation bound to another revision is rejected.
- A `complete` record has no failed or errored checks, no unmet criteria and no violated
  `error` rules (schema); every claim is supported by an observation able to support its
  type, recorded independently enough for the profile's policy, and every required
  check type has a passing result (library). A gap is visible but cannot complete a task.

## Feature

One entry of the feature map: name, summary, status, actors, code paths and typed
entrypoints, data it touches, dependencies on other features and integrations, and a
confidence. Nothing in it assumes a domain or an architecture; `entrypoints[].kind`
includes `other`.

## Project Context (`ContextDocument`)

Frontmatter of a Markdown document in `.paved/project/`. It carries the knowledge state:

| State | Representation |
|---|---|
| Known | `confidence: declared` (a human stated it) or `observed` (read from the code) |
| Inferred | `confidence: inferred` |
| Unknown | `unknowns[]` with a reason and a question |
| Conflicting | `conflicts[]`, each statement citing the source it came from |
| Stale | Computed from source hashes; never stored |

`observed` and `inferred` require provenance (schema).

## Provenance

The single definition of where knowledge came from: generator (or `human`), generator
version, time, source revision, identified sources with hashes and lines, output hash and
review status. Generated provenance must carry `generator_version` and `output_sha256`,
so human edits and outdated generators are detectable.

## Override

The only way to modify inherited content. Entries are grouped by target kind (`tools`,
`rules`, `skills`, `workflows`); each has a `target` (qualified id), an `action`, an `owner`, a
`reason` and optionally `target_sha256`. Operations are few and conservative: rules
`set-severity`/`disable`, skills `extend`/`disable`, workflows `extend`/`disable`. There
is no replace. Semantics and conflict detection: [inheritance](inheritance.md).

## Adapter

A technology package: id `<category>/<name>`, version, required Core range and other
adapters (with ranges), detection rules, what it provides, and the official sources its
content is based on. Compatibility is detectable from `requires` alone.

## Generator and generated artifact

A generator declares its inputs, outputs and change detection. Each output declares
where its metadata lives: `inline` (the output's schema has a `provenance` field) or
`sidecar` (a `<file>.paved.yaml` of kind `GeneratedArtifact` next to it). A sidecar
must name a real generator, never `human`. Decision:
[ADR 0013](../decisions/0013-generated-artifact-metadata.md).

## Machine-enforceable rules

Rules that cross fields or documents, and where they are enforced. Structural
constraints of a single field are in the schemas and not repeated here.

| Rule | Enforced by |
|---|---|
| `apiVersion` is present, well formed and supported; newer and older versions are reported as such | `checkApiVersion` |
| Qualified ids have a known namespace and the right number of segments for their kind | Schema |
| Every qualified reference resolves to an artifact of the right kind | `resolveReferences` |
| Core references only Core; an adapter only Core and itself | `resolveReferences` |
| Overrides never target project content | `resolveReferences` |
| Every override has an owner and a reason | Schema |
| `observed`/`inferred` context and features carry provenance | Schema |
| Generated provenance has `generator_version` and `output_sha256`; sidecars are never `human` | Schema |
| Cited source ids are declared; managed blocks are well formed, uniquely identified and cite sources | `assessProvenance` |
| `complete` evidence has no failed checks, unmet criteria or violated `error` rules | Schema |
| Evidence using profile checks names the profile | Schema |
| Claims are supported by suitable, passed, sufficiently independent observations | `assessEvidence` |
| Agent-recorded reviews and manual observations support nothing | `assessEvidence` |
| Observations match the change revision | `assessEvidence` |
| A deprecated skill has `deprecation`; `experimental` is `0.x`, `stable` is `>= 1.0.0` | Schema |
| Skill dependencies are acyclic; required check types can prove something | `dependencyCycles`, `unprovingRequiredChecks` |
| Skills stay small and generic and mention everything their contract lists | `assessSkillQuality` |
| Complete evidence satisfies the required checks and evidence kinds of its producer skills | `assessSkillEvidence` |
| A deprecated workflow has `deprecation`; skipped phases never include verification, evidence, completion | Schema |
| Workflows are ordered, gate destructive tools, require provable checks and do not duplicate skills | `assessWorkflowQuality` |
| Run records match their workflow (order, skips, attempts, approvals, failure codes) | `assessRun` |
| Complete evidence satisfies its workflow's required checks and evidence kinds | `assessWorkflowEvidence` |
| Approval gates are decided by a named person, never an agent | Schema; `assessRun` |
| Short skill and workflow names are unique in the effective set | Planned (composition) |
| Adapter names are unique across categories | Planned (adapter registry) |
| Overrides do not target `overridable: false` rules; one override per target | Planned (composition); tested for the template |
| Override drift (`target_sha256`) suspends subtractive operations | Planned (`paved update`) |
| Source hashes match (staleness); `output_sha256` matches (human edits) | Planned (`paved status`) |

The full list, including Core-repository rules, is in
[enforcement candidates](../maintenance/enforcement-candidates.md).
