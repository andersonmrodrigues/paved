# Project verification skill layout

Create this project-owned tree, choosing a short slug from the application's name or
interface:

```text
.paved/skills/verify-<slug>/
├── SKILL.md
├── skill.yaml
└── references/
    └── features.md
```

`SKILL.md` uses the Agent Skills frontmatter fields `name` and `description`. Its name
matches the directory (`verify-<slug>`), and its description says the guide is ready or
is a draft. The body includes these sections:

- `When to use`
- `Required context`
- `Preconditions`
- `Procedure`
- `Tools`
- `Rules`
- `Verification`
- `Evidence`
- `Completion criteria`
- `Failure modes`
- `References`

The project `skill.yaml` has id `project.testing.verify-<slug>`, category `testing`,
version `0.1.0`, and status `experimental`. It requires `manifest` and `verification`
context, requires the `runtime` check and `check-result` evidence, and lists
`references/features.md` in `references`. Include optional tool ids only when the
project actually configures compatible implementations.

`references/features.md` starts with YAML frontmatter that validates against
`schemas/verification-guide.schema.yaml`:

- `apiVersion` and `kind`, as the schema requires.
- `status`: `draft` or `ready`.
- `features`: each covered feature-map `id`, with the `entrypoints` it covers, named as
  in that feature's `code.entrypoints`.
- `deferred`: user-visible feature-map ids knowingly left for later.
- `sources`: each feature-map document the guide was written from, as `location` and
  the `sha256` of the file when the guide was last checked.

List every user-visible feature-map entry (one with a `ui`, `http` or `cli` entry point)
under `features` or `deferred`. `paved doctor` reports covered features or entry points
missing from the feature map, user-visible features in neither list, and sources whose
digest changed.

The body begins with the verification status (`ready` or `draft`), safe launch
preconditions and cleanup boundary. For each feature, include exactly these headings in
order:

1. `Sub-features` — concise user-visible behaviors covered.
2. `How to get to it (user POV)` — every known user entry point.
3. `Driving it with <harness>` — prerequisites, the exact configured action, and the
   observable result. Cite where the action came from. Say whether it was exercised.
4. `Gotchas` — state, access or cleanup conditions that affect the result.

Use exact project commands only when they appear in project configuration or
documentation. A feature is `ready` only after one configured runtime check has passed
with an artifact. Otherwise keep the whole guide in `draft`, explain the missing
capability and do not describe an unexercised action as proof.
