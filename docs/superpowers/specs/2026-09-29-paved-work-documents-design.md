# Paved Work Documents in Consumer Repositories

- **Status:** Approved and implemented
- **Date:** 2026-09-29
- **Scope:** Standard location and workflow behavior for durable work documents in consumer repositories.

## Problem

Paved stores workflow run state and temporary evidence under `.paved/generated/`,
but does not define a durable location for the Markdown documents an agent and user
create together: intent, plans, specs, task breakdowns, and research. This leaves
documents scattered across repository roots or temporary paths, and the preview
workflow has no canonical document location.

## Goals

- Give all Paved-managed repositories one predictable home for agent-authored work documents.
- Keep these documents inside the repository and versioned with the work they describe.
- Make workflow-generated plans discoverable and reviewable through `paved preview`.
- Keep durable documents separate from disposable run state and evidence.
- Keep the contract technology- and domain-agnostic.

## Proposed contract

Use `.paved/documents/` as the durable document root. It is `project-owned`, committed,
and never regenerated or deleted by Paved. The standard categories are:

```text
.paved/documents/
  intents/<run-id>.md
  plans/<run-id>.md
  specs/<run-id>.md
  tasks/<run-id>.md
  research/<run-id>.md
```

Categories are created when first used; init need not create empty directories.
The same workflow run id ties related documents together. A human-readable slug may
precede the run id where useful, but the run id remains in the filename.

## Workflow behavior

- `plan`, `feature`, `fix`, and `refactor` create or update their plan at
  `.paved/documents/plans/<run-id>.md` and use that exact file for approval hashing.
- The agent opens that canonical plan in `paved preview`; selected-text comments are
  applied to the file and resolved before approval is requested for its latest hash.
- Intent, spec, task breakdown, and research documents created during a run use their
  matching category and the same run id. A document is created only when that artifact
  is meaningful to the task.
- `.paved/generated/runs/` remains the source for machine-readable workflow state;
  `.paved/generated/evidence/` remains disposable evidence. Documents do not replace
  either store.
- Existing consumers' plans at arbitrary paths remain readable for existing runs.
  New workflow runs use the canonical path. If enforcement is added, it must not make
  a resumed run fail solely because its existing plan lives elsewhere.

## Initialization and ownership

Add `.paved/documents/` as an optional committed `project-owned` entry in
`consumer_layout`. `paved init` may create the directory scaffold without overwriting
existing files; alternatively, agents create category directories on demand. The
consumer health check must not require documents to exist for a repository to be
READY. No new document schema is introduced: these are ordinary Markdown artifacts,
not typed Paved configuration.

## Agent instructions

Update the canonical workflow instructions and projected skills so agents save work
documents under the matching category and consistently pass the canonical plan path
to preview and workflow approval. Document this location in the consumer layout and
repository lifecycle docs.

## Non-goals

- Moving Paved configuration, Project Context, approvals, or evidence into this tree.
- Imposing a schema/frontmatter format on every Markdown work document.
- Committing disposable run records, preview comments, or local evidence.
- Providing a document browser or a new document-management command.

## Open implementation choice

Whether `paved init` creates the empty category scaffold or workflows create folders
on demand. Both preserve the same path contract; choose based on existing init and
ownership semantics during implementation planning.

## Acceptance criteria

1. The consumer contract describes `.paved/documents/` as committed `project-owned`
   durable work-document storage.
2. Workflows and agent instructions name canonical paths for intent, plan, spec,
   tasks, and research documents.
3. Newly created workflow plans use the canonical plan path and the preview approval
   remains bound to that file's exact digest.
4. Existing arbitrary-path workflow plans remain resumable.
5. Status does not require any document or category directory to exist.
6. Documentation distinguishes durable documents from generated run state and evidence.
