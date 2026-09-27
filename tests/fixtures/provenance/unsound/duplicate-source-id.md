---
# expect-problem: declares a source id more than once
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
    - { id: client, type: file, location: src/other.ext }
---

