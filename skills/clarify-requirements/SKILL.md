---
name: clarify-requirements
description: Work out how this issue could be read, pick the reading you will build to, and put it on the record before starting. Does not ask the client anything. Use after assess-scope, before starting work on an issue that asks for code changes.
---

# Clarify Requirements

An issue can be complete and still be read two ways. When that happens you build
one of them, and the client discovers which from a finished pull request.

This check makes the reading explicit **before** the work, so a wrong reading is
visible in the first minute rather than at review.

## This skill does not ask the client anything

**Do not call AskUserQuestion. Do not emit an elicitation. Do not wait.** State
your reading and get on with it.

That is a deliberate constraint, not an oversight — see *Why this does not ask*
at the end. Everything below is about deciding what to record, not about
whether to interrupt.

## Work out the readings

Go through the issue and, for each instruction, ask what it could mean other
than what you first assumed. Most instructions have one plausible reading. You
are looking for the ones with two.

This applies to what the issue **says**, not only to what it omits. A specified
detail can still be ambiguous — a value whose format is assumed, a table cell
whose notation is not spelled out, an instruction that reads as an example to
some people and as an exhaustive list to others. A filled-in field is a place
where guessing happens, and "the issue told me" is not the same as "the issue
told me unambiguously".

Forks worth noticing:

- One instruction, two readings, and the two produce different artefacts.
- A notation, format or convention you are inferring rather than reading.
- Something required-or-optional in a way that changes the user's flow.
- An instruction that could be the whole list or one example of a list.
- Two statements that contradict each other.
- A term that means more than one thing in this codebase.

**Length and specificity are not the signal.** A long, detailed,
confident-sounding issue can turn on one instruction that reads two ways, and
its very specificity is what stops you looking.

**The repo is an answer.** An existing pattern, a neighbouring component, or a
convention in the codebase resolves a fork — read it rather than treating the
fork as open.

## Record the reading, then build

If you found nothing genuinely two-way — the common case — say nothing and
continue to the appropriate skill for the work. Silence is the correct output of
a passed check.

If you did find a fork that would change what gets built, post **one short
`thought` activity** before starting, containing:

- the fork, in one line;
- the reading you are building to;
- why that reading (repo convention, the more common case, the smaller
  reversible option).

Then build it. Do not wait for a reply. If the client disagrees they will say
so, and it is on the record from the first minute rather than discovered at
review — which is the whole point.

Keep it to the forks that would change the artefact. A list of every assumption
you made is noise.

## Why this does not ask

The asking version of this check was built and measured against 18 real client
issues on reconstructed pre-merge trees. It never once asked — under two
different framings — including on issues whose original sessions demonstrably
cost rework. Shipping a question path that has never fired would add an
unpredictable interruption to client work with no evidence it fires when it
should.

Two things must be true before the ask path is enabled:

1. **Invocation is reliable.** This skill is currently skipped in roughly a
   third of sessions despite explicit routing, so its decisions cannot be
   measured.
2. **Calibration is measured where the phenomenon lives** — a new client's first
   week. Issues written by people who know the codebase sit at or below the
   floor of detectable ambiguity, so they cannot validate it.

Recording the reading is the part that pays for itself now: it costs nothing,
never interrupts, and puts the interpretation somewhere the client can see it.
