# Templates

Starting points used by `paved init`, by generators and by people adding content by hand.
YAML templates, and Markdown templates whose frontmatter has a `kind`, are valid
documents (tests validate them against their schemas); replace every `example` value.
Markdown templates define the required sections (tests check that
real skills and workflows contain them).

| Template | Instantiates | Where it lives when used |
|---|---|---|
| `manifest.yaml` | Project manifest | `.paved/manifest.yaml` |
| `AGENTS.md` | Consumer agent entrypoint | Consumer root `AGENTS.md` (inside the Paved block) |
| `skill.md` + `skill.yaml` | Skill | `<skills root>/<category>/<name>/SKILL.md` and `skill.yaml` |
| `workflow.md` + `workflow.yaml` | Workflow | `<workflows root>/<name>/WORKFLOW.md` and `workflow.yaml` |
| `feature.yaml` | Feature map entry | `.paved/project/feature-map/<id>.yaml` |
| `context-document.md` | Project Context document (frontmatter + managed blocks) | `.paved/project/<area>/<name>.md` |
| `rule.yaml` | Rule | `core/rules/<category>/<name>.yaml` or `.paved/rules/<category>/<name>.yaml` |
| `tool.yaml` | Tool capability contract (no executable) | `core/tools/<group>/<name>.yaml` or `.paved/tools/<group>/<name>.yaml` |
| `tool-implementation.yaml` | Binding from Tool capability to an argv or synthetic implementation | `core/tool-implementations/<group>/<name>.yaml`, adapter equivalent, or `.paved/tool-implementations/<group>/<name>.yaml` |
| `check.yaml` | Check definition | `.paved/verification/checks/<group>/<name>.yaml` |
| `evidence.yaml` | Evidence record | `.paved/generated/evidence/<id>.yaml` |
| `workflow-run.yaml` | Workflow run record | `.paved/generated/runs/<id>.yaml` |
| `verification-profile.yaml` | Verification profile | `.paved/verification/profile.yaml` |
| `overrides.yaml` | Project overrides | `.paved/overrides/overrides.yaml` |
| `adapter.yaml` | Technology adapter | `adapters/<category>/<name>/adapter.yaml` |
| `generator.yaml` | Generator contract | `generators/<id>/generator.yaml` |
| `generated-artifact.yaml` | Sidecar for a generated file without inline provenance | `<generated file>.paved.yaml` |
