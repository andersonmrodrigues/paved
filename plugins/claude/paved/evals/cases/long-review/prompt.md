---
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: Review the supplied change for actionable correctness risks, separating confirmed findings from unknown context.
---
Review this finished code change for correctness risks:

    export function parseLimit(value: string): number {
      return Number(value);
    }

    export function getVisibleItems(items: readonly Item[], value: string): readonly Item[] {
      return items.slice(0, parseLimit(value));
    }

Existing callers pass "10" and "0". The patch contains no validation or fallback. Identify only issues supported by this diff, state what additional context you need for uncertain claims, and do not write a fix.
