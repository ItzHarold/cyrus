/**
 * Client-facing message templates (PON-168 / R2).
 *
 * Every literal here lands on a TENANT surface. Keeping them in one module
 * is what makes the content-policy sweep total: the sweep test iterates
 * these exports (plus literal-extraction over the other registered emitting
 * modules), so a banned term in any of them is a test failure, not a
 * production incident.
 */

export const CLIENT_MESSAGES = {
	/** PON-161: worktree creation refused at session start. */
	worktreeRefusedAtStart: (repositoryName: string) =>
		`This session could not start: the latest code for ` +
		`**${repositoryName}** could not be fetched, and starting against a ` +
		`stale copy would be worse than not starting. The operator has been ` +
		`notified — once repository access is restored, re-delegate this issue.`,

	/** PON-164: worktree creation refused on resume. */
	worktreeRefusedOnResume: (repositoryName: string) =>
		`This session could not resume: the latest code for ` +
		`**${repositoryName}** could not be fetched, and continuing against a ` +
		`stale or missing copy would be worse than stopping. The operator has ` +
		`been notified — once repository access is restored, re-delegate this issue.`,

	/** PON-164: re-creation produced no usable working copy. */
	workspaceUnpreparable: () =>
		`This session could not resume: a clean working copy of the ` +
		`repository could not be prepared. The operator has been notified — ` +
		`re-delegate this issue once the repository is healthy again.`,

	/** PON-139: undeclared workspace refusal. */
	workspaceNotConfigured: () =>
		`This workspace is not configured to run sessions on this host — its ` +
		`credential is missing or unavailable. The operator has been notified; ` +
		`once configuration is fixed, re-delegate this issue.`,

	/** PON-152 ladder: the honest delay note on the client's issue. */
	verificationDelayNote: () =>
		`This one is taking longer than planned — the work is in final ` +
		`verification on our side. No action needed from you; we'll post the ` +
		`result here as soon as it clears.`,

	/**
	 * PON-138: retries at session start ran out against a provider outage.
	 * Honest, client-framed, and actionable without being alarming.
	 */
	sessionStartFailed: () =>
		`We hit a temporary problem on our side starting this one, and ` +
		`automatic retries didn't get through. The operator has been ` +
		`notified. Nothing is needed from you — re-delegating the issue ` +
		`later will also restart it.`,

	/**
	 * PON-179: the one generic status a quiet client stream shows instead of
	 * working narration — liveness without the diary.
	 */
	workingStatus: () =>
		`On it. This thread will update when there's something for you to ` +
		`review or answer.`,

	/**
	 * PON-171: the delivery footer appended to the held summary when the
	 * operator approves. Sections render only when present; an empty call
	 * renders nothing.
	 */
	deliveryFooter: (
		previewUrl?: string,
		mergeUrls?: string,
		reviewNotes?: string,
	) => {
		const lines = [
			previewUrl ? `**See it working:** ${previewUrl}` : "",
			mergeUrls ? `**To take it:** merge ${mergeUrls}` : "",
			reviewNotes ? `**Notes from our review:** ${reviewNotes}` : "",
		].filter(Boolean);
		return lines.length ? `---\n${lines.join("\n")}` : "";
	},
} as const;
