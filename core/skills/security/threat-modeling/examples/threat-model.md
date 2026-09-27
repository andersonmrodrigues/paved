# Example: threat model

Synthetic. The system is invented; only the shape matters.

**Change.** Users can upload a document, which is stored and later downloaded by other
members of the same team.

**Model.**

| Flow | From | To | Boundary crossed |
|---|---|---|---|
| Upload | User's client | Upload service | Internet to service |
| Store | Upload service | Object storage | Service to storage |
| Download | User's client | Upload service | Internet to service |

**Assets.** Document contents (confidential to the team); storage capacity (cost).

**Threats.**

| # | Flow | Category | Threat | Decision |
|---|---|---|---|---|
| 1 | Download | Elevation of privilege | A user downloads another team's document by changing its identifier | Mitigated: team membership checked at the server on every download; test required |
| 2 | Upload | Denial of service | Very large or very many uploads exhaust storage | Mitigated: size limit and per-user quota; test required |
| 3 | Upload | Tampering | A file claims one type but contains another, served back to users as active content | Mitigated: content type set by the server; downloads served as attachments; review point |
| 4 | Store | Information disclosure | Storage readable without the service | Open: storage access policy unknown; asked the owner |

**Unknowns.** Retention period for deleted documents.
