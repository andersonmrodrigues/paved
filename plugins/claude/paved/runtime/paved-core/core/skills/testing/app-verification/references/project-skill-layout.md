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

`references/features.md` begins with the verification status (`ready` or `draft`), safe
launch preconditions and cleanup boundary. For each feature, include exactly these
headings in order:

1. `Sub-features` — concise user-visible behaviors covered.
2. `How to get to it (user POV)` — every known user entry point.
3. `Driving it with <harness>` — prerequisites, the exact configured action, and the
   observable result. Cite where the action came from. Say whether it was exercised.
4. `Gotchas` — state, access or cleanup conditions that affect the result.

Use exact project commands only when they appear in project configuration or
documentation. A feature is `ready` only after one configured runtime check has passed
with an artifact. Otherwise keep the whole guide in `draft`, explain the missing
capability and do not describe an unexercised action as proof.
