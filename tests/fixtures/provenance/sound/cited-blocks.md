---
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
    - { id: config, type: file, location: sample.config }
  output_sha256: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
---

# Sample

Human-written text.

<!-- paved:begin generated id=clients sources=client,config confidence=observed -->
Generated text.
<!-- paved:end generated -->

<!-- paved:begin generated id=notes sources=config -->
More generated text.
<!-- paved:end generated -->
