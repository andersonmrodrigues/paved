---
# expect-problem: cites source "readme", which provenance does not declare
apiVersion: paved/v1
kind: ContextDocument
area: integrations
title: Sample
confidence: inferred
provenance:
  generator: project-context/integrations
  generator_version: 0.1.0
  generated_at: 2026-01-01T00:00:00Z
  sources:
    - { id: client, type: file, location: src/client.ext }
  output_sha256: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
---

<!-- paved:begin generated id=clients sources=client,readme -->
Generated text.
<!-- paved:end generated -->
