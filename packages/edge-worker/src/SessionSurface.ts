import type { AgentSessionPlanStep } from "cyrus-core";

/**
 * Builds the session-level plan checklist from the task list the session is
 * already maintaining.
 *
 * The plan mirrors real task state rather than inventing granularity: steps
 * appear when the model creates tasks and change status when it updates them.
 * If the model keeps no task list, there is nothing to publish and nothing is
 * published — a missing checklist reads as "this agent doesn't show plans",
 * whereas an empty or half-filled one reads as broken.
 *
 * The platform REPLACES the plan on every update rather than merging, so every
 * publish sends the complete ordered list.
 */
export class SessionPlanTracker {
	/** Insertion-ordered: Map preserves the order tasks were created in. */
	private readonly steps = new Map<string, AgentSessionPlanStep>();
	/** Latches off after a failed publish, so a stale plan is never churned. */
	private disabled = false;

	/** Record a task the session created. Ignores duplicates and blanks. */
	addTask(id: string, subject: string): void {
		if (!id || !subject?.trim() || this.steps.has(id)) return;
		this.steps.set(id, { label: subject.trim(), status: "pending" });
	}

	/**
	 * Move a task to a new status. Unknown ids are ignored rather than
	 * invented — a step whose label we never saw would render as a blank row.
	 */
	updateTask(id: string, status: string): void {
		const step = this.steps.get(id);
		if (!step) return;
		const mapped = SessionPlanTracker.mapStatus(status);
		if (mapped) step.status = mapped;
	}

	/** Cyrus task statuses -> platform plan statuses. */
	private static mapStatus(
		status: string,
	): AgentSessionPlanStep["status"] | null {
		switch (status) {
			case "pending":
			case "todo":
				return "pending";
			case "in_progress":
			case "inProgress":
				return "inProgress";
			case "completed":
			case "done":
				return "completed";
			default:
				return null;
		}
	}

	/**
	 * The full plan to publish, or null when there is nothing honest to show.
	 *
	 * Null means "publish nothing" — never an empty array, which would render
	 * as an empty checklist.
	 */
	snapshot(): AgentSessionPlanStep[] | null {
		if (this.disabled || this.steps.size === 0) return null;
		return [...this.steps.values()].map((s) => ({ ...s }));
	}

	/** Stop publishing for this session after a failed update. */
	disable(): void {
		this.disabled = true;
	}

	get isDisabled(): boolean {
		return this.disabled;
	}
}

/**
 * Finds the PR and preview URLs a session produces, so they can be surfaced as
 * link buttons on the session itself.
 *
 * Measured demand: across ten real client issues, three had the client asking
 * for a preview link or merge button in the thread, and in one case the links
 * already existed via the GitHub/Vercel integrations — they just were not where
 * the client was looking.
 *
 * Each link is emitted once. Nothing is emitted speculatively: no URL, no
 * button — and a preview URL is emitted only when it can be attributed to this
 * session, because a link that points at someone else's deploy is worse than no
 * link at all.
 */
export class SessionLinkTracker {
	private static readonly PR_RE =
		/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
	// Vercel preview deployments; the generic case is a *.vercel.app host.
	private static readonly PREVIEW_RE =
		/https:\/\/[\w.-]+\.vercel\.app\b[^\s)\]"']*/g;

	private prUrl: string | null = null;
	private previewUrl: string | null = null;
	/** Lowercased issue identifier, e.g. `chb-27`, used to attribute previews. */
	private readonly marker: string | null;

	/**
	 * @param issueIdentifier - the session's issue, e.g. "CHB-27". Without it,
	 *   no preview link is ever emitted: an unattributable URL is exactly the
	 *   case that sends a client to someone else's deploy.
	 */
	constructor(issueIdentifier?: string | null) {
		const m = (issueIdentifier ?? "").trim().toLowerCase();
		this.marker = m.length > 0 ? m : null;
	}

	/**
	 * Scan a chunk of session text. Returns links newly discovered by THIS
	 * call, so the caller publishes each exactly once.
	 */
	scan(text: string | undefined | null): Array<{ url: string; label: string }> {
		if (!text) return [];
		const found: Array<{ url: string; label: string }> = [];

		if (!this.prUrl) {
			const m = text.match(SessionLinkTracker.PR_RE);
			if (m) {
				this.prUrl = m[0];
				found.push({ url: m[0], label: "Pull request" });
			}
		}

		if (!this.previewUrl && this.marker) {
			for (const raw of text.match(SessionLinkTracker.PREVIEW_RE) ?? []) {
				const url = raw.replace(/[.,;:]+$/, "");
				if (!SessionLinkTracker.attributable(url, this.marker)) continue;
				this.previewUrl = url;
				found.push({ url, label: "Preview" });
				break;
			}
		}
		return found;
	}

	/**
	 * A preview URL is only ours if its host carries this session's issue
	 * identifier. Vercel embeds the branch in preview hostnames — a branch like
	 * `cyrussh/chb-27-manage-order-...` yields
	 * `champions-box-git-cyrussh-chb-27-manage-or-<hash>-<team>.vercel.app`.
	 *
	 * Anything else is someone else's deployment, the project's production
	 * alias, or a URL the agent merely quoted. A wrong preview link is worse
	 * than no link: the client clicks it and sees another deploy or a 404, and
	 * a link that lies costs more trust than a link that is absent.
	 */
	private static attributable(url: string, marker: string): boolean {
		try {
			return new URL(url).hostname.toLowerCase().includes(marker);
		} catch {
			return false;
		}
	}
}
