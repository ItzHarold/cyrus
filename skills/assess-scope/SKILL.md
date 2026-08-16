---
name: assess-scope
description: Check whether an issue is small enough to ship as one pull request before starting work, and propose a split if it clearly is not. Use at the start of any new issue that asks for code changes.
---

# Assess Scope

One issue should be one feature, fix, or change that ships as a single pull request
in roughly a day. Work that is clearly larger gets split **before** any code is
written, so the client sees the shape of the work up front instead of receiving a
sprawling PR days later.

## The bar: bias toward working

Most issues are fine. Propose a split **only when the oversize is obvious**, not
when the work merely looks substantial. A hard problem in one area is not
oversized; a day of careful work on one feature is exactly right.

**Clear oversize — propose a split:**

- Multiple unrelated features in one issue ("add SSO, and a dark mode toggle, and CSV export")
- An "and also" chain that keeps introducing new surfaces
- A migration *plus* features built on top of it
- A cross-cutting refactor bundled with new behaviour
- Work that obviously spans several PRs because the pieces ship independently

**Not oversize — just start working:**

- One feature that happens to touch several files
- One bug whose root cause is deep or unclear
- A single refactor, even a large one
- Anything you could plausibly finish and ship in a day
- Anything ambiguous or borderline

When you are unsure, **start working**. A needless split proposal costs the client
a round trip and makes the service feel obstructive. Missing one costs a rework.
The first is the more common failure, so weight against proposing.

## If the issue is clearly oversized

**Do not write code, do not create a worktree branch, do not open a PR.**

1. Work out the split first. Each proposed sub-issue must be independently
   shippable, ordered so earlier ones unblock later ones, and scoped to a day or
   less. Prefer three to five pieces; if you need more than about six, the split
   itself is probably wrong — group them.

2. Ask the client using the **AskUserQuestion** tool. You get exactly one
   question, so put the whole proposal in the question text:

   - State plainly why the issue is too large for one PR — one sentence.
   - List the proposed sub-issues, numbered, each with a title and a one-line scope.
   - Offer these options: **"Proceed with this split"** and **"Adjust the split"**.
     Linear adds a free-text option automatically, so the client can also reply
     with their own wording.

   Keep it short and concrete. The client is deciding, not reading a document.

3. **Wait for the answer.** Do not begin work while the question is open.

## After the client answers

**Approved** — create the sub-issues, then close the loop:

- Create each one with `mcp__linear__save_issue`: omit `id` to create, set
  `parentId` to the original issue, `team` to the original's team, and
  `assignee` to the same assignee as the original so the agent picks them up.
- Create them in execution order. They enter the queue in the order created.
- Give each a description that stands alone: what to build, the acceptance
  criteria, and any context from the original that the sub-issue needs.
- Post a final response on the original issue listing the sub-issues that were
  created, in order, with their identifiers.
- **Leave the original issue open.** Say in the response that the work now lives
  in the sub-issues and the original can be closed. Closing it is the client's
  action — the same as merging. Do not close it yourself.

**Adjusted** — take the client's changes, re-propose **once** with the same
one-question format. Do not negotiate further after that.

**Still contested after one adjustment** — stop proposing. Implement the first
shippable slice only, and say so plainly in your response: what you are building
now, and what is deliberately left out. Do not silently build everything.

**Declined outright** ("just do it") — respect it. Build the most valuable
coherent slice you can ship well, and be explicit in the response about what you
covered and what remains.

## After the assessment

If the issue is not oversized — the common case — say nothing about scope and
continue straight to the appropriate skill for the work. Do not narrate that you
checked. Silence is the correct output of a passed check.
