# UX and interaction principles

Use this catalog whenever a task changes a user-facing interface or flow. Scan every
group, select the principles that bear on the user's goal, and record the design
implication and tradeoff in the plan or review. For a substantial flow redesign, consider
every group explicitly. The website review prompt supplied with this task names twelve
principles; those are all represented here and in the checklist below. Do not cite a law as
proof that a design is usable: validate the actual task, audience, platform, accessibility
needs, and available research. This is a working catalog of widely used principles, not a
claim that UX has one complete or universally agreed list of laws.

## Interaction effort and choices

| Principle | Design question |
|---|---|
| Fitts's law | Are frequent or consequential controls easy to reach and large enough to acquire? Reduce distance and increase usable hit area where practical; do not enlarge every control without regard to density or context. |
| Hick–Hyman law | Does the user face too many choices at once? Group, prioritize, progressively disclose, or provide search when that reduces decision effort without hiding important choices. |
| Steering law | Do users have to move through narrow, error-prone paths, such as nested menus or constrained drag targets? Widen forgiving paths or provide a simpler route. |
| Doherty threshold | Does the interface respond quickly enough to keep the interaction feeling continuous? Give timely feedback and communicate progress when work cannot complete quickly. |
| Tesler's law (conservation of complexity) | Where must unavoidable complexity live? Keep it out of the user's way where possible, while preserving needed control and transparency. |

## Familiarity, learning, and memory

| Principle | Design question |
|---|---|
| Jakob's law and consistency standards | Does the interface follow familiar platform, domain, and product conventions? Depart when it serves a clear user need, and make the new behavior understandable. |
| Recognition over recall | Can users recognize available actions and information instead of remembering hidden commands, prior values, or steps? Keep relevant choices and context visible. |
| Mental models and mapping | Do labels, control placement, and cause-and-effect match what the intended users expect? Make system state and consequences legible. |
| Miller's law / chunking | Is information grouped into meaningful, manageable chunks? Do not interpret the often-misquoted “seven items” as a fixed limit; chunk around the task. |
| Serial-position effect | Are the most important items placed where users are most likely to notice or remember them, especially at the beginning or end of a sequence? |
| Zeigarnik effect | Are unfinished tasks clearly represented so users can resume them? Do not use open loops or reminders merely to manipulate attention. |

## Perception and visual organization

| Principle | Design question |
|---|---|
| Gestalt proximity | Are related items visually close and unrelated groups clearly separated? |
| Gestalt similarity | Do controls that behave alike look consistent, and are meaningfully different controls distinguishable? |
| Common region | Are related items grouped with a shared boundary, background, or container when proximity alone is ambiguous? |
| Prägnanz (good form) | Can the visual structure be simplified while preserving meaning and discoverability? Simplicity must not erase needed distinctions. |
| Visual hierarchy and signal-to-noise | Does emphasis guide attention to the user's primary task, with decoration and competing emphasis kept in check? |
| Von Restorff (isolation) effect | Is distinctiveness reserved for information or actions that truly need attention, rather than applied everywhere? |
| Aesthetic-usability effect | Could visual polish affect perceived usability? Do not treat attractiveness as evidence of actual usability; inspect task success separately. |

## Feedback, control, and recovery

| Principle | Design question |
|---|---|
| Visibility of system status | Does the interface show what happened, what is happening, and what can happen next? |
| User control and freedom | Can users cancel, go back, undo, or safely correct an action where appropriate? |
| Error prevention and recovery | Can likely errors be prevented without blocking valid work? When errors happen, are messages specific, actionable, and non-blaming? |
| Peak–end rule | Are the most stressful moments and the end of a meaningful journey handled clearly and respectfully? Do not optimize a memorable ending at the expense of the whole journey. |
| Postel's law (robustness principle) | Does input handling tolerate reasonable variation while feedback and output remain clear? Apply cautiously: permissive input must not create ambiguity, security issues, or surprising data changes. |

## Accessibility and inclusive use

| Principle | Design question |
|---|---|
| Perceivable, operable, understandable, robust (WCAG principles) | Can users perceive content, operate controls, understand the interaction, and use it with assistive technologies? Check the applicable WCAG criteria, not just this summary. |
| Target size and spacing | Are pointer targets large enough or sufficiently separated to reduce missed and accidental activation? Check WCAG 2.2 SC 2.5.8 and the product's stricter platform guidance where relevant. |
| Contrast, focus, keyboard, and motion | Are text and controls perceivable, focus visible, all functions keyboard-operable, and motion respectful of reduced-motion preferences? |
| Universal design and user diversity | Does the design work across relevant abilities, devices, input methods, language levels, and usage conditions? Avoid assuming one “average” user. |

## Applying the catalog

1. Identify the user, goal, flow, and interface states affected.
2. Scan each group above, including all twelve principles in the supplied website prompt:
   Jakob, Hick, Fitts, Miller/chunking, Von Restorff, aesthetic-usability, proximity,
   serial position, peak–end, Doherty, Tesler, and Zeigarnik. Also check the other applicable
   principles in this catalog. For relevant principles, note the concrete choice they inform;
   for principles that appear relevant but are not applied, give a short context-based reason.
3. Resolve tensions using user evidence, accessibility requirements, product constraints, and
   the task's priorities. Principles can conflict; there is no universal ranking.
4. Review the rendered interface and interaction. Record what was observed and what remains
   unverified. A checklist or a passing automated accessibility scan is not a usability test.
5. For a site critique, state the visitor, primary goal, and desired action when known; inspect
   the supplied pages or screenshots at relevant viewport sizes; report concrete observations,
   prioritize the highest-impact fixes, and suggest revised copy only when requested or useful.
   A numeric score is optional and must be tied to explicit observable criteria; never imply
   precision unsupported by the evidence. Do not optimize conversion at the expense of user
   welfare, accessibility, truthful content, or the stated product goal.

## Sources

- [Fitts's Law and Its Applications in UX](https://www.nngroup.com/articles/fitts-law/) — Nielsen Norman Group (NN/g).
- [Maintain Consistency and Adhere to Standards](https://www.nngroup.com/articles/consistency-and-standards/) — NN/g; includes Jakob's law.
- [Hick's Law: Making the Choice Easier for Users](https://lawsofux.com/hicks-law/) — Laws of UX reference; use as a qualitative guide, not a literal interface formula.
- [Gestalt Principles for Design](https://www.nngroup.com/articles/gestalt-principles/) — NN/g.
- [Proximity Principle in Visual Design](https://www.nngroup.com/articles/gestalt-proximity/) — NN/g.
- [Recognition vs. Recall in User Interfaces](https://www.nngroup.com/articles/recognition-and-recall/) — NN/g.
- [The Magical Number 7 and UX](https://www.nngroup.com/articles/magical-number-7/) — NN/g; cautions against applying seven as a universal limit.
- [The Peak–End Rule: How Impressions Become Memories](https://www.nngroup.com/articles/peak-end-rule/) — NN/g.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [Understanding SC 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) — W3C WAI.
- [Laws of UX](https://lawsofux.com/) — a curated collection of commonly referenced principles, not a normative standard.
- [Prompt das Leis de UX](https://docs.google.com/document/d/1Eez5GHGUi4jD9DSJZg1UgtA7_E3rQspwqeBy1kGHaEM/edit?tab=t.0) — user-provided website critique prompt; its twelve principles are covered above.
