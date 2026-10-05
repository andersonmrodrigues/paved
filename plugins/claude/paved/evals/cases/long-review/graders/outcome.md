---
type: llm
---
PASS if the response identifies that zero yields an empty slice result and asks whether zero is intended or invalid, while avoiding claims about an unseen fallback.
FAIL if it invents code not in the summary, gives generic style advice as a finding, or writes a fix.
