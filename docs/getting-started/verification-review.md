# Verification and Evidence review

Status: architecture and contracts established; **not production-ready**. This review
covers the Paved Core only. No consumer repository was analyzed.

## Architecture

The task's [plan](../concepts/verification.md) combines workflow, skill, rule and
acceptance requirements. A [Check](../concepts/checks.md) states one objective question,
its preconditions and expected verdict. The Check names a Tool; the Tool supplies the
execution mechanism. The execution yields observations and artifact references. An
[Evidence record](../concepts/evidence.md) binds them to a revision and names which
claims each result supports. The assessor recomputes completion from the record.

The verification profile lists available check ids. It does not duplicate Check or
Tool definitions. The Core contains generic checks for schema validation, reference
validation, artifact provenance, workflow completion and skill compliance. Adapter and
project checks may add technology-specific execution. Tests are one mechanism among
static analysis, architecture, security, performance, runtime and other types in the
[registry](../../core/verification/registry.yaml).

## Evidence semantics

The plan has required, recommended and optional check types plus required evidence
kinds. Every required type needs a passed check for `complete`. A missing required type
is recorded as a gap, but the task remains incomplete. `verified` means all required
types passed; `partially-verified` means some passed; `unverified` means none passed.
Warning rules and missing recommended checks do not block completion.

Checks record status (`passed`, `failed`, `error`, `blocked`, `skipped`, `inconclusive`),
recorder, tool version, timestamp, revision and environment when captured. Failed checks
retain summary, observations or output reference. A later record may supersede but does
not erase them. Large artifacts stay outside YAML and are referenced through the
canonical provenance source format. Local records may be disposable; change, release
and audit records follow their declared retention class.

Evidence binds to an immutable revision. A dirty working tree adds a digest to the
subject and each check. The assessor rejects mismatched revisions or working tree
digests. It separates agent self-reporting from `paved` and CI capture; a profile or
check may require an independent recorder. Agent-recorded reviews and manual
observations cannot support claims. Captured output digests and recorder identity will
need a future runner or CI integration for independent validation.

## Execution and rigor

Checks declare deterministic, controlled or nondeterministic behavior, with sources
such as clocks, random data, networks, concurrency and environment drift. A precondition
that prevents execution yields `blocked`; a check that does not apply is `skipped`.
Neither passes. Retries are bounded by the Check contract. Disagreeing attempts remain
visible and yield an inconclusive flaky result. Repeated identical failures call for
debugging, Gardener or human review.

Performance checks compare a recorded baseline and current value under a declared
workload with a project threshold. Runtime checks can cover startup, health probes,
API calls and telemetry without requiring an observability stack. A future UI adapter
can navigate, interact, observe, capture and assert, producing screenshots, DOM state
or traces. Formal verification is an optional advanced mechanism unless a workflow
requires it. The Core defines no universal numeric rigor ladder or default profiles:
explicit workflow and rule requirements determine what a task needs.

## Validation audit

| # | Area | Current enforcement or finding |
|---|---|---|
| 1 | Verification artifacts | Check schema, Core Check validation, template and fixtures |
| 2 | Evidence artifacts | Evidence schema, template, sound/unsound and synthetic fixtures |
| 3 | Tool integration | Check → Tool references resolve; safety, inputs and timeout are assessed |
| 4 | Workflow integration | Plan coverage checked against workflow phases and required evidence |
| 5 | Skill integration | Plan coverage checked against producer skills; agent instructions updated |
| 6 | Schema consistency | Ajv strict compilation, manifest registration and check-type registry sync |
| 7 | Provenance | Recorder, tool version, timestamp and artifact source fields; output digest validation pending |
| 8 | Revision binding | Subject and observation revisions compared; dirty tree digests compared |
| 9 | Failure semantics | Failed/error checks block; observations and output references retained |
| 10 | Retry semantics | Check retry is bounded; attempts assessed against definitions |
| 11 | Flaky handling | Disagreeing attempts produce inconclusive, never a clean pass |
| 12 | Performance | Baseline/current comparison; workload and threshold recorded by the project |
| 13 | Runtime | First-class check type and synthetic result; execution adapter pending |
| 14 | Architecture | First-class check type; project constraints supplied later |
| 15 | Core genericity | Core Check prose and component boundaries tested; no consumer added |
| 16 | Consumer isolation | Only synthetic fixtures used; no real repository analyzed |
| 17 | Agent self-declaration | Claims need typed support; self-reported results remain labeled |

The [self-tests](../../tests/README.md) and `npm run check` cover the current contracts.
This audit does not validate a live execution runner or a real consumer project.

## Open decisions and next work

- Implement `paved verify` and `paved evidence` on the shared library, capturing tool
  output, environment and immutable revision automatically.
- Decide how CI signs or otherwise authenticates recorder identity and how artifact
  digests are checked after retention or download.
- Connect workflow run approvals and gates to completion assessment with authenticated
  human identity.
- Test adapter-provided browser, runtime, security and performance checks in a later
  synthetic adapter, then pilot against a consumer repository in a separate phase.
- Decide project policy for release and audit retention and external artifact storage.
