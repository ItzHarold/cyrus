/**
 * PON-110: single source of truth for the Claude session model.
 * Read from env on every call. Never cached, never persisted, no default.
 */
export function getPinnedModel(): string {
	const model = process.env.CYRUS_MODEL?.trim();
	if (!model) {
		throw new Error(
			"CYRUS_MODEL is not set — refusing to start a Claude session without a pinned model (PON-110).",
		);
	}
	return model;
}

/** Exact match, or snapshot resolution: pin "claude-opus-5" accepts "claude-opus-5-2026xxxx". */
export function modelSatisfiesPin(
	actual: string,
	pinned = getPinnedModel(),
): boolean {
	return actual === pinned || actual.startsWith(`${pinned}-`);
}
