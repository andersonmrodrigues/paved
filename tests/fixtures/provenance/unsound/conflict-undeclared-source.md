---
# expect-problem: conflict 1 cites source "spec"
apiVersion: paved/v1
kind: ContextDocument
area: integrations
title: Sample
confidence: declared
provenance:
  generator: human
  generated_at: 2026-01-01T00:00:00Z
  sources:
    - { id: client, type: file, location: src/client.ext }
conflicts:
  - topic: Sample
    statements:
      - { statement: One., source: client }
      - { statement: Two., source: spec }
---

