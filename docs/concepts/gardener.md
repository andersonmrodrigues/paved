# Gardener

`paved gardener` is a local, read-only analysis command. It reads one consumer's
existing Evidence records from `.paved/generated/evidence/` and
`.paved/verification/evidence/`, the last generator run in
`.paved/generated/state/last-run.json`, and the human corrections recorded in workflow
runs under `.paved/generated/runs/`. It does not run verification or generators.
The Gardener skill remains the procedure for deeper human-led diagnosis.

`gardener` is a CLI subcommand, not an agent command. Agents meet its results at the end
of `execute`: when a run completes, `execute` runs the same analysis and lists only the
candidate proposals not reported before, keyed by proposal id and `evidence_sha256` in
`.paved/generated/gardener/reported.json`. A reviewed proposal is not listed again; a
changed `evidence_sha256` lists it again. The list is advisory: it never changes rules,
skills or checks, and a gardener failure or proposal never changes the run's outcome.
Adopting a proposal stays a decision taken with `paved gardener`.

## Observation and evidence

The service validates Evidence against the existing schema. Failed/error checks, violated rules, and missing required verification become observations. Generator conflicts and unknowns become observations from the existing run state. A check may also record an `implementation-pattern` fact; Gardener observes its fingerprint but never proposes a rule from its repetition alone. It never scans source code for frequent patterns or treats current code as desired architecture. It does not read raw check logs or copy summaries, commands, environment values, or unknown text into output. Each observation includes a stable id, consumer scope, category, subject, knowledge state, confidence, occurrence count, first and last recorded time, record/item references, and repository-relative provenance sources with content hashes. The `GardenerObservation` schema reuses the existing provenance source definition.

Observed, documented, enforced, inferred, and unknown remain distinct. A failed configured check is `enforced`; a violated Rule or missing required verification is `documented`; a generator conflict is `observed`; a generator unknown stays `unknown`. These labels describe the evidence source, not the cause. Current state, desired state, and enforced state are never inferred from repository repetition alone.

## Human corrections

Run records are validated against the `WorkflowRun` schema only, so runs from an older
workflow version still count; an invalid run is skipped and named. Two records are
corrections, category `correction`, state `documented`: a `plan-approved` gate a person
rejected, and an applied review decision where a person sent blocking findings back to
implementation (`fix`). Both group by workflow. When a person chooses `fix`, the review
gate also records the rules the blocking findings cite in their optional `rule` field;
each becomes a correction of that rule. Findings accepted as they are, plan amendments
and revisions, and preview comments are not corrections: they record no person
correcting the agent, or only free text.

Violations and corrections of one rule form one proposal with the violation proposal's
id. The Gardener reads the rule's definition from the Core, the adapters and
`.paved/rules/`. A rule enforced only by the `agent` or by `review` that has two or more
distinct evidence items is a promotion candidate (`rule_enforcement.promotion_candidate`):
the proposal recommends static analysis, or architecture when the rule already sits at
static analysis, and states the layer order architecture, static analysis, test or CI
check, documentation. Every proposal that recommends architecture, static analysis or
verification carries an `adoption_requirement`: before adoption, the new check or
structure must be shown failing on a fixture reproducing one of the cited mistakes, then
passing once it is corrected.

## Stated corrections

A person often corrects an agent with a rule that holds for the whole project ("applied
migrations are immutable"). Kept only in the agent's notes, it never reaches the project,
and the person repeats it to the next agent. The core instructions and the `gardener`
skill tell the agent to propose it instead:

```bash
paved gardener correction --text "<the person's words>" --evidence db/migrations/V1.sql:3 --json
```

`--text` is the statement, verbatim. Each `--evidence` (repeatable, at least one) is a
project file with optional lines `path[:start[-end]]`, a commit or an `http(s)` URL; free
text is refused, so every proposal points at something a person can open. The command
compares the statement with every Core rule, project rule (`.paved/rules/`) and pending
correction, ignoring case, punctuation, diacritics and plurals. Adapter rules are not
compared yet:

| Outcome | When | Writes |
|---|---|---|
| `duplicate` | An existing Core or project rule already says it (similarity of 0.6 or more) | nothing; `duplicate_of` names the rule |
| `merged` | A pending correction already says it | the statement and new evidence are added to that draft, which counts how often it was stated |
| `proposed` | Nothing says it yet | a draft Rule under `.paved/generated/proposals/rules/corrections/<slug>.yaml` |

`related` lists rules with partial overlap (0.3 or more) for the person to compare. The
draft is a valid Rule (`project.corrections.<slug>`, the statement as `rule`, enforced by
the `agent` at the `rule` layer, severity `warning`, the evidence as `references`) with a
header saying it is a draft. Its `GeneratedArtifact` sidecar records the statements as
`human` sources, the evidence as `file`, `revision` or `url` sources with digests, and
`proposal_for: .paved/rules/corrections/<slug>.yaml`. `status` checks the sidecar like any
generated proposal. A draft edited by hand is not merged into; the command refuses until
it is regenerated or adopted. `--dry-run` reports the outcome and writes nothing.

Each pending draft is a project decision, returned by `paved gardener correction` and by
every `paved gardener` run. Only the person answers it: `adopt` writes the rule, without
the draft header, to `.paved/rules/corrections/` and removes the draft; `decline` writes
no rule and is not asked again until the draft's evidence changes, for example when the
person states it again. Scope (`applies_to`) and severity start open; the person narrows
them, or promotes the rule to a stronger layer, in the adopted file.

A stated correction does not need two incidents: the person who states it has already
agreed the correct behavior. Paved never reads the conversation; the agent passes the
words it was given, and the Gardener copies only those.

## Aggregation and diagnosis

Grouping uses the consumer name and stable check, Rule, verification type, or generator identity. Two distinct evidence items are required for a candidate; repeated command runs against unchanged input return the same ids and ordering. A retained Evidence copy and its generated original count once. A single generator run cannot establish historical recurrence. Proposals contain the supporting observation and evidence references, a cautious root-cause statement, layer recommendation and rationale, expected effect, and explicit uncertainty. A failing check alone does not prove a structural root cause; the proposal asks reviewers to investigate that possibility.

## Review lifecycle

The analysis writes nothing; only a person's answer to a proposal decision, and `paved gardener correction`, write files. It returns observations and candidate proposals in structured JSON or human output. Optional human-owned `.paved/gardener/reviews.yaml` records review events by proposal id: `UNDER_REVIEW`, `ACCEPTED`, `IMPLEMENTED`, `REJECTED`, `DEFERRED`, and `SUPERSEDED`. `IMPLEMENTED` requires an earlier `ACCEPTED` event; supersession requires a replacement id. Review metadata includes reviewer, time, reason, and the proposal's `evidence_sha256`. Rejection applies to that evidence set: new evidence reopens the candidate while keeping the historical rejection in the human-owned review file. A human applies approved changes separately through the existing ownership and lifecycle mechanisms. The review file is never written by Gardener.

The current command never creates active Rules, Skills, Workflows, architecture, verification policies, tool contracts, adapters, or generator changes. It never modifies Core, application source, the lock, or human-owned `.paved/` files. `--dry-run` is accepted for CLI consistency and has the same read-only behavior. Exit code 0 means analysis with no new candidates, 1 means candidates, 4 means invalid input, and 9 means an unexpected runtime failure. `--json` exposes typed observations and proposals.

## Isolation and limits

Analysis always targets one consumer. A consumer pattern remains consumer-scoped even if another consumer has the same pattern. Core promotion needs separate human review with evidence from multiple consumers and a technology-neutral argument; The reusable `considerCoreCandidates` function can compare two or more explicitly supplied consumer results and return a review-only `CoreImprovementCandidate`; the consumer CLI never calls it. Generality and technology independence remain unknown until human review. Technology-specific interpretation remains in adapters and existing check definitions. Apart from the list of already reported proposals that `execute` keeps, this implementation does not retain Gardener artifacts in generated state, inspect unstructured corrections such as chat transcripts or comment text (a stated correction is text the agent passes explicitly), infer architecture from code, or aggregate across consumers. Historical observations are limited by the Evidence records a consumer retains and by Generator Runtime's last-run state. Proposal ids are stable for a pattern; new evidence updates the proposal's evidence list without changing its id.

No remote analysis or learning is used. The command reads local metadata and returns only relative record paths and hashes; the consumer controls evidence retention and access. Treat the human-owned review file as a decision record, not as an enforcement mechanism.
