---
name: clarify-requirements
description: Check whether an issue contains enough to build the right thing, and ask once — with proposed defaults — if it genuinely does not. Use after assess-scope, before starting work on an issue that asks for code changes.
---

# Clarify Requirements

An issue needs three things to be buildable: **what** to build, **where** it
lives, and what **done** looks like. When one is genuinely missing, asking costs
a round trip. Guessing wrong costs the whole build, plus the client's time
reading a PR that does the wrong thing.

Asking is the exception. Most issues are buildable.

## Run this after assess-scope, and only one of you may stop

`assess-scope` runs first. If it proposed a split, **stop — do not also ask
clarifying questions.** The work now belongs to the sub-issues and their
requirements are their own problem. Two questions in one session is two round
trips, and it reads as an agent that cannot get started.

**At most one pause per session.** If you have already asked something, you do
not get to ask again.

## The bar

Ask only when a wrong guess produces **the wrong artefact** — something that
must be thrown away or rebuilt, not something that needs a tweak in review.

**Ask when:**

- The issue names an outcome but not which of several existing surfaces it
  applies to, and the choice changes what gets built.
- Something is required-or-optional in a way that changes the user's flow, and
  the issue does not say which.
- Two statements in the issue contradict each other.
- A term is used that means more than one thing in this codebase, and the two
  readings lead to different work.
- "Done" is unstated *and* unguessable — not merely unstated.

**Do not ask when:**

- The answer is in the repo. Read it. An existing pattern, a neighbouring
  component, or a convention in the codebase is an answer, not an ambiguity.
- A sensible default exists. Choose it, build it, and say plainly in your
  final response which way you went and why. A stated assumption is cheaper
  for the client than a question.
- The detail is cosmetic, or is the kind of thing review catches — copy,
  spacing, ordering, naming.
- The uncertainty is about **runtime behaviour you cannot know until you run
  it** — a third-party API's real responses, credential shapes, live data. No
  question answers that. Build, run, and report what you find.
- You are merely uncomfortable with how large or unfamiliar the work is. That
  is not ambiguity.

**Length is not the signal.** A long description can be ambiguous on the one
point that matters, and a short one can be perfectly clear. Judge whether you
could build the wrong thing, not how much text you were given.

When you are unsure whether to ask, **don't**. Build, state your assumption,
and let review correct it.

## How to ask

You get **exactly one question**. This is a hard limit — the runner rejects a
call carrying more than one, and Linear renders one message with one set of
options. So the whole thing goes in a single **AskUserQuestion** call.

Put **at most three** questions in the body, and next to each, **the answer you
will assume if they say nothing**. This is the point of the pattern: the client
can approve everything with one click, and only has to type about the parts they
disagree with.

Structure the body like this:

- One sentence on what you are about to build.
- The questions, numbered, each with the default you would take. Be concrete —
  name files, routes, components, states. Never "can you provide more details".
- Nothing else. The client is making a decision, not reading a document.

Offer these options:

- **"Use these defaults"** — the primary. Say plainly that this starts the work
  immediately.
- **"I'll answer inline"** — an affordance, not a step. Linear accepts a free-text
  reply whether or not this is clicked, so make the label read as "I'm going to
  type instead", never as a button they must press before answering. Do not
  turn it into an extra round trip.

Then **wait**. Do not start building while the question is open.

## After they answer

**"Use these defaults", or no objection** — build exactly what you proposed.

**They answered some or all of it** — take their answers, keep your stated
defaults for anything they did not mention, and build. **Do not ask again.**
Only a genuine contradiction — where their answer makes the work impossible or
conflicts with something else in the issue — justifies a second question, and
even then prefer to state the conflict and your resolution in your response.

**"Just use your judgment" or similar** — proceed immediately. State the
interpretation you chose in a `thought` activity so the choice is on the record,
then build.

## When the issue is fine

Say nothing about clarity and continue to the appropriate skill for the work.
Do not narrate that you checked. Silence is the correct output of a passed
check.
