---
# Frontmatter of every Markdown document under .paved/project/ (schema: ContextDocument).
apiVersion: paved/v1
kind: ContextDocument
area: architecture
title: Example overview
confidence: inferred
provenance:
  generator: project-context/architecture
  generator_version: 0.1.0
  generated_at: 2026-01-01T00:00:00Z
  source_revision: 4f2c9e1
  sources:
    - id: build-file
      type: file
      location: build.config
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    - id: readme
      type: file
      location: README.md
  output_sha256: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
  review:
    status: unreviewed
unknowns:
  - topic: Runtime topology
    reason: Deployment is configured outside this repository.
    question: Where are the components deployed, and how many instances run?
conflicts:
  - topic: Number of deployable units
    statements:
      - statement: The build file defines two deployable units.
        source: build-file
      - statement: The README describes a single service.
        source: readme
    question: Is the second unit still deployed?
---

# Example overview

Human-written text outside managed blocks is never changed by generators.

<!-- paved:begin generated id=components sources=build-file confidence=observed -->
Generated content, with its own sources and confidence. Regenerated only when its previous
content can be verified against a trusted baseline; a human takes ownership by deleting
the markers.
<!-- paved:end generated -->
