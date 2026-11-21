# `paved context`

`paved context "<topic or project-relative path>"` retrieves matching feature-map
summaries and applicable Core and project rules without modifying the repository.
Project rules take priority over Core rules when the result reaches its size limit.

`--budget <bytes>` limits the UTF-8 bytes in the returned context, defaulting to
1500. This conservative byte budget is not a model-specific token count. The
result includes `matched` and `truncated`; a truncated result is incomplete and
must not be treated as the full set of applicable rules. Narrow the query or raise
the budget before relying on it.

`paved context refresh` regenerates only areas reported stale by Paved's generation
evidence. When that evidence is unavailable, name the areas explicitly with
`--areas architecture,domain,product,integrations,feature-map,rules,skills,tools,verification`.
Repeat `--areas` or pass a full generator id to select other installed generators.
Required generator dependencies may also run; the result lists the selected areas
and each generator's outcome. Human-edited generated documents are never overwritten:
conflicts produce proposals and a non-success result for review.
The result includes exact `changedFiles`; with `--dry-run`, it is empty and
`wouldChangeFiles` lists outputs that would be written. Newly written conflict proposals
are included in `changedFiles`.
