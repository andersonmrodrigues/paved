# ADR 0049: Human corrections feed the Gardener; guide drift is a doctor finding

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

[ADR 0023](0023-read-only-consumer-gardener.md) limits the Gardener to Evidence records
and the last generator run. The strongest signal that an agent keeps making the same
mistake is a person correcting it, and Paved already records some corrections in
structured form: a plan a person rejected, and blocking review findings a person sent back
to implementation. Rules declare how they are enforced (`enforcement.mechanism`), so a
rule that only the agent or a reviewer enforces and that keeps being broken can be named
as a candidate for a stronger layer. A check proposed for that rule is only worth adopting
if it would have caught the recorded mistake.

Separately, the app-verification skill writes a project-local guide from the feature map,
and nothing tells anyone when the two drift apart.

## Decision

The Gardener also reads `.paved/generated/runs/*.yaml`, validated against the
`WorkflowRun` schema only, so runs written by an older workflow version still count. It
turns two kinds of record into observations of the new `correction` category, state
`documented`, with the run file and its SHA-256 as provenance:

- a `plan-approved` gate a person `rejected`, grouped by workflow;
- an applied `run.review` decision answered `fix`, grouped by workflow.

When a person sends blocking findings back, the review gate now records an
`evidence-recorded` event that names the fix and the rules the blocking findings cite in
their new optional `rule` field. The findings file is overwritten by the next review,
so the run event is the durable record. Each cited rule becomes a correction of that rule.

Violations (from Evidence) and corrections of the same rule form one proposal, keeping
the id the violation proposal already had so earlier reviews still apply. When the
rule's definition (Core, adapter or `.paved/rules/`) says `mechanism: agent` or `review`
and two or more distinct evidence items support it, the proposal carries
`rule_enforcement.promotion_candidate: true` and recommends the next stronger layer:
static analysis by default, architecture when the rule already sits at static analysis.
Any proposal that recommends architecture, static analysis or verification carries an
`adoption_requirement`: the new check or structure must be shown failing on a fixture
reproducing a recorded mistake, and passing once it is corrected.

Not used as corrections: approved plan amendments and plan revisions before approval
(their origin, agent or person, is not recorded, and they are routine iteration), blocking
findings accepted as they are (a person declined to correct), and Markdown preview
comments (free text with no stable subject; the Gardener does not copy unknown text).

Drift between a verification guide and the feature map is a `doctor`/`status` finding,
not a Gardener observation: it is a single current-state fact, needs no recurrence, and
sits next to the existing context-drift and verification-profile findings. The guide's
`references/features.md` gains `VerificationGuide` frontmatter listing covered features
and entry points, deferred features and the digests of the feature-map documents it was
written from. Doctor reads only that frontmatter and reports covered features or entry
points missing from the map, user-visible map features neither covered nor deferred, and
changed digests. It never rewrites the guide.

## Consequences

- The Gardener remains read-only and advisory; corrections only add observations and
  proposals.
- All schema changes are additive: a new category value Paved writes, optional proposal
  fields, an optional `rule` on review findings and a new document kind. The adoption
  requirement is optional in the schema and required by the Gardener skill; making it a
  schema requirement would reject documents that were valid.
- Run records change while a run is active, so a correction's `evidence_sha256` can
  change until that run ends; a rejected proposal may reopen once when it does.
- Corrections recorded before this change have no rule event, so they count per
  workflow but not per rule.
- A guide without the frontmatter gets an informational finding only.

## Alternatives considered

- **Parse review finding summaries or decision reasons for rule ids.** Rejected: free
  text, and the Gardener does not copy or interpret unknown text.
- **Keep every findings file.** Rejected: a new retained artifact per review round for
  one field.
- **Make `adoption_requirement` required for check-adding layers in the schema.**
  Rejected as a breaking tightening of a released schema.
- **Report guide drift as a Gardener observation.** Rejected: the Gardener needs two
  distinct evidence items, and drift is a present fact, not a recurrence.

## References

- [ADR 0023](0023-read-only-consumer-gardener.md)
- [Gardener](../concepts/gardener.md)
- `schemas/gardener-proposal.schema.yaml`, `schemas/verification-guide.schema.yaml`
