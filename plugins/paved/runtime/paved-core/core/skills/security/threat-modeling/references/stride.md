# Threat categories

A checklist for step 4, based on the STRIDE categories. Apply it to each flow that
crosses a trust boundary; skip categories that clearly cannot apply, and say why.

| Category | Property violated | Question to ask at the boundary | Typical mitigations |
|---|---|---|---|
| Spoofing | Authentication | Can someone pretend to be another user, service or component? | Authentication of every caller, including internal ones; mutual authentication between services; no identity taken from untrusted input |
| Tampering | Integrity | Can data be changed in transit, at rest or in a request the server trusts? | Validation at the boundary; integrity protection in transit; server-side recomputation of values the client sends |
| Repudiation | Non-repudiation | Could someone deny having performed a sensitive action? | Audit records of who did what and when, protected from the actors they record |
| Information disclosure | Confidentiality | Can data reach someone who should not see it: in responses, errors, logs, caches, backups? | Authorization on read paths; minimal responses; redaction in logs and errors; encryption where the data rests outside the boundary |
| Denial of service | Availability | Can a caller exhaust a resource: time, memory, storage, connections, money? | Limits on size, rate and cost per caller; timeouts; bounded queues |
| Elevation of privilege | Authorization | Can a caller do something their role does not allow, directly or through another component acting for them? | Authorization on every operation at the server; least privilege for services; no trust in client-side checks |

## Also consider

- **Supply chain**: new dependencies, build steps and external services are components
  with their own boundaries.
- **Secrets**: where each secret lives, who can read it, how it is rotated.
- **Defaults**: what happens on missing configuration or a failed check (deny, not allow).
