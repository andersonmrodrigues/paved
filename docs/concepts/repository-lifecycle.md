# Repository lifecycle

How a consumer repository adopts Paved and keeps up with the Core. Commands are
specified in [cli/](../../cli/README.md) and not implemented yet; the
[integration guide](../getting-started/integrating-a-repository.md) describes the manual
equivalent.

## Initialization

```text
paved init
      ↓
repository discovery          confirm repository root; refuse if already initialized
      ↓
technology detection          evaluate adapter `detect` signals
      ↓
adapter resolution            propose adapters → human confirms → versions locked
      ↓
project context generation    run generators → .paved/project/ (unreviewed)
      ↓
verification setup            propose a verification profile → human adopts it
      ↓
validation                    paved doctor: schemas, references, commands
      ↓
ready for agents              AGENTS.md block points agents at Paved
```

"Ready" still means Project Context is unreviewed. Agents treat unreviewed context as
`inferred` until humans review it; the repository state is reported by `paved status`.

## Update

```text
paved update
      ↓
core update                   resolve newest Core within the manifest range (or --to)
      ↓
compatibility check           Core range, apiVersion, adapter requirements
      ↓
project context validation    validate .paved/ documents against the new schemas
      ↓
migration if necessary        dry run → confirmation → apply → validate again
```

Updates never modify human-owned files without per-file consent, and never write
outside the paths their contract allows.

### What an update touches

| Step | Reads | Writes |
|---|---|---|
| Resolve | Manifest ranges, available versions | Nothing yet |
| Compatibility | New Core manifest, adapter `requires` | Nothing yet |
| Validation | Every `.paved/` document against the new schemas | Nothing yet |
| Override review | `target_sha256` of every override against the new targets | Nothing; reports overrides that need review |
| Migration | Documents with an older `apiVersion` | Migrated documents, after confirmation |
| Apply | | `.paved/paved.lock`, `.paved/generated/core/` |
| Report | | A summary of changed Core content affecting this project: rules, skills and workflows it uses; new rules that now apply |

Every write happens after every check, so a failed update leaves the repository exactly
as it was.

## Change impact

When the Core changes, the impact on a consumer is computed, not guessed:

| Core change | Affected consumers | Detected by |
|---|---|---|
| Schema change | Those with documents of that kind | Validation against the new schema |
| Rule change | Those where the rule's `applies_to` matches, or with an override on it | Rule diff + override digests |
| Skill or workflow change | Those that use it and have not disabled it; those that extend it | Diff + override digests |
| New rule | All, unless its `applies_to` excludes them | Composition |
| Removed content | Those with overrides on it (error until removed) | Composition |

The same mechanism applies to adapter updates.

## Staying current

- Generated context goes stale when its sources change. `paved status` reports stale
  documents; `paved generate` refreshes them following the merge strategy in
  [ownership and regeneration](ownership-and-regeneration.md).
- Evidence and Gardener proposals feed back into rules, skills and verification. See the
  [gardener skill](../../core/skills/gardener/gardener/SKILL.md).
