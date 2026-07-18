---
name: scope-discipline
description: Apply goal-decomposition discipline to multi-step tasks. Use when a user task has 3+ verifiable deliverables, has independent checkpoints, or is likely to surface tangential work. Decompose into sub-goals, write a decomposition file to disk, set per-sub-goal token budgets, and stop between sub-goals for user check-in.
---

# Scope discipline — Goal decomposition

For any task with **more than one verifiable deliverable**, decompose into
sub-goals before starting. Full reference: `/home/dracon/chat/pi/pi-discipline/decomposition.md`.
One-page cheatsheet: `/home/dracon/chat/pi/pi-discipline/cheatsheet.md`.

## When to decompose

- 3+ independent deliverables (diagnose → patch → verify → document, etc.)
- Obvious checkpoint where evidence (file, test, PR) can prove one step done
  before the next
- High chance of needing user input mid-flight

Skip decomposition for: single bounded questions, "just a quick check" asks,
or fake sub-steps with no real evidence boundary.

## The protocol

1. **Write the decomposition to disk FIRST.**
   Path: `<project>/.pi/decomposition.md` or `~/.pi/agent/decomposition.md`
   for cross-project work.
2. **Reference the decomposition in the objective.** Every `create_goal` call
   should mention the decomposition file by path so post-compaction the model
   can re-anchor.
3. **Tight per-sub-goal token budgets.** 15-25k for fix/verify, 30-40k for
   design/audit. If a sub-goal needs >40k, it's actually two sub-goals.
4. **Stop between sub-goals.** Mark the checkbox, report one-line checkpoint,
   stop. Wait for user's next prompt.
5. **Surface, don't absorb.** If tangential work appears, use
   `ask_user_question`. Never silently add a sub-goal. Never silently drop it.

## Decomposition file template

```md
# Decomposition: <task name>

## Sub-goals
- [ ] **<name>** — <one sentence>. Evidence: <file/cmd>. Budget: <N>k.
- [ ] **<name>** — ...

## Out of scope (will surface as questions, not absorb)
- <item>

## Stop points
- After sub-goal N: confirm before continuing.

## Tangential work surfaced during execution
- <item> — raised at <stop point>, user said: <decision>
```

## Behavior rules (non-negotiable)

1. No new sub-goal without telling the user.
2. Stop at every check-in point. Do not "and now moving on to step N+1."
3. Compact-friendly: each sub-goal's objective references the decomposition
   file by path.
4. Evidence before completion: file written, test run, command output, PR
   state. "I think this works" is not evidence.
5. Budget per sub-goal, not per session. Tight budgets force checkpoints.

## Failure modes to avoid

- "While I was at it I also..." — never
- "I also fixed X because it was related" — never (note, ask)
- "This turned out bigger, let me push through" — stop, check in, decide
- A single `create_goal` with objective >200 words — definitely two sub-goals
