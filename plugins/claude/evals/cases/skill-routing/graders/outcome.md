---
type: llm
---
PASS if the response either drafts a concise, actionable issue with a clear outcome and testable acceptance criteria, or asks one focused question about the unresolved meaning of “export saved reports” before drafting. If it asks, the question must offer plausible options and avoid listing additional future questions.
FAIL if it invents the CSV contents, merely restates the request, gives an implementation plan instead of an issue, or asks a batch of follow-up questions rather than resolving the first important ambiguity.
