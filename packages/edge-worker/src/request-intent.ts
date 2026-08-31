/**
 * What is this message asking for? (PON-229)
 *
 * Two surfaces have the same problem. On a cockpit mirror, every message the
 * reviewer types is classified `iterate` — the catch-all is a work directive,
 * deliberately, because refusing to act on plain instructions was the defect
 * PON-208 fixed. On a delivered client issue, §8.8 needs the same call: a
 * question to answer versus a change to make.
 *
 * They are one mechanism because the failure is one failure. Found live on
 * CKP-22: the reviewer asked "why did you make this its own file instead of
 * keeping the notes inline?" — a question about a decision — and the session
 * edited files, committed, pushed a second commit onto the branch under
 * review and rewrote the pull request description. Nothing in the chain was
 * broken; the message simply arrived wrapped in "carry on working".
 *
 * On the client surface the same bug would be worse. Not "the reviewer's
 * diff moved under them" but "the client asked a question and we silently
 * changed their software", after delivery, in front of them.
 *
 * INTRINSIC, per the standing design principle: the model decides, because a
 * code-side classifier over free English is exactly the enforcement shape
 * that has failed here three times. What machinery guarantees is that the
 * question is always ASKED, on every turn, on both surfaces.
 *
 * The asymmetry is the load-bearing part. Both blocks say which way to fall
 * when it is genuinely unclear, and why: answering something that wanted
 * action costs one message, and acting on something that wanted an answer
 * costs work nobody asked for on a branch someone was mid-review of.
 */

/** The reviewer's thread on a cockpit mirror. Technical register. */
export function buildReviewerRequestBlock(): string {
	return `

<what_is_being_asked>
Before you touch anything, decide what this message is.

**A question** asks you to explain something that already exists — why you
made a call, how something works, what a change does, whether something is
covered. Answer it and change NOTHING: no edits, no commits, no pushes, no
pull-request edits, no new branches. Read whatever you need to answer well;
reading is free. "Why did you…", "what does…", "how does…", "is there a
reason…", "did you consider…" are questions, and they stay questions even
when your answer is "you're right, that was the wrong call" — say so, and
wait to be told to change it.

**A directive** asks you to change the work — do it, on the same branch, and
say what you did.

**If you genuinely cannot tell**, ask one short question and stop.

When it is close, treat it as a question. Answering something that wanted
action costs one message and the reviewer simply says "yes, do it". Acting on
something that wanted an answer rewrites the branch they were mid-review of,
and they have to find out what changed and put it back.
</what_is_being_asked>`;
}

/**
 * The client's own thread after their work has been delivered (§8.8).
 *
 * Same decision, client register, and one addition: a change request is not
 * acted on directly. It is restated as a deliverable and confirmed, because
 * post-delivery work re-enters the queue through review like any other work
 * — the client never gets an unreviewed change, however small it sounds.
 */
export function buildDeliveredRequestBlock(): string {
	return `

<what_is_being_asked>
This work has been delivered. The client can see it and may reply about it.
Before you do anything, decide what their message is.

**A question** — why something works the way it does, what changed, how to
use it, whether something is included. Answer it in their language, from what
was delivered. Change nothing: no edits, no commits, no pushes. Never explain
our internal process, our review, or how any of this is built; answer about
their software.

**A change request** — something is wrong, missing, or they want more. Do NOT
start working on it, however small it looks. Say back what you understand
they want, as the outcome they would get, and ask them to confirm it. It goes
through the same review their first delivery did, and a change made straight
onto delivered work is a change nobody reviewed.

**If you cannot tell**, ask them one short question.

When it is close, treat it as a question. Answering something that wanted a
change costs one message. Changing delivered software because a question
sounded like a request is something they did not ask for and did not approve.
</what_is_being_asked>`;
}
