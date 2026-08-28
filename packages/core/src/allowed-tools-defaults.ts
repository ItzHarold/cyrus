/**
 * Per-platform default allowed-tool lists.
 *
 * These are the single source of truth for "what tools does Cyrus have access
 * to when a session is triggered by platform X". cyrus-hosted and any
 * self-host configuration imports these constants verbatim; the database
 * stores per-team overrides only, and falls back to these lists when a team
 * has not customized its allowed-tool set.
 *
 * Resolution is **additive only** — there is no implicit appending of
 * workspace MCP tools at runtime. Anything Cyrus needs (including
 * `mcp__linear`, `mcp__cyrus-tools`, `mcp__cyrus-docs`, `mcp__slack`, and
 * read access to repository paths) is listed here explicitly. If you remove
 * a tool from this list, Cyrus loses access to it. If you add a tool here,
 * existing teams whose column equals the previous verbatim default will be
 * migrated forward; teams who have customized their list are left alone.
 *
 * The three lists are intentionally maintained independently — sharing tools
 * between platforms is fine and expected, but the lists do not derive from
 * each other.
 */

/**
 * Default allowed tools for Linear-triggered agent sessions.
 *
 * Linear sessions are full engineering sessions — Cyrus opens worktrees,
 * runs builds, edits files, and opens PRs. This list mirrors the full
 * Claude Agent SDK toolset plus the workspace MCP prefixes Cyrus needs
 * to read and write Linear state.
 */
export const LINEAR_DEFAULT_ALLOWED_TOOLS = [
	// File system
	"Read",
	"Edit",
	"Write",
	"NotebookEdit",

	// Execution
	"Bash",
	"Task",

	// Web
	"WebFetch",
	"WebSearch",

	// Worktree management
	"EnterWorktree",
	"ExitWorktree",

	// User interaction
	"SendMessage",
	"PushNotification",

	// Task lifecycle
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",

	// Scheduling
	"CronCreate",
	"CronDelete",
	"CronList",
	"ScheduleWakeup",

	// Monitoring + discovery
	"Monitor",
	"RemoteTrigger",
	"ToolSearch",
	"Skill",

	// Design sync
	"DesignSync",

	// Workflow orchestration
	"Workflow",

	// Findings reporting
	"ReportFindings",

	// Workspace MCP servers — explicit, no implicit appending. Linear
	// sessions include `mcp__slack` so Cyrus can post status updates and
	// follow-up messages to Slack while working on an issue.
	"mcp__linear",
	"mcp__cyrus-tools",
	"mcp__cyrus-docs",
	"mcp__slack",
] as const;

/**
 * Default allowed tools for Slack `@mention` chat sessions.
 *
 * Slack sessions are transient — no PRs opened, no worktree checkouts.
 * The default list grants read-only access to repository sources (so Cyrus
 * can answer "look at the code in repo X" questions) plus the standard
 * planning/task tools, but no Edit/Write/general Bash. The single Bash
 * pattern allowed is `git -C * pull` so a chat session can refresh a
 * repo before grepping it.
 */
export const SLACK_DEFAULT_ALLOWED_TOOLS = [
	// Read access to configured repository paths
	"Read",
	"Bash(git -C * pull)",

	// Web
	"WebFetch",
	"WebSearch",

	// User interaction — Slack chat sessions need to send replies back
	// to the channel and schedule follow-ups.
	"SendMessage",
	"ScheduleWakeup",

	// Planning + task lifecycle
	"Task",
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",

	// Discovery
	"Monitor",
	"Skill",
	"ToolSearch",

	// Workspace MCP servers Slack chat sessions need
	"mcp__linear",
	"mcp__cyrus-tools",
	"mcp__cyrus-docs",
	"mcp__slack",
] as const;

/**
 * Default allowed tools for GitHub-triggered agent sessions.
 *
 * GitHub sessions are full engineering sessions like Linear (Cyrus opens
 * PRs, edits files, runs builds), so the toolset mirrors the Linear
 * default — except `mcp__slack` is excluded since Slack is its own
 * platform with its own allowed-tool list.
 *
 * Maintained as an independent list (NOT derived from
 * `LINEAR_DEFAULT_ALLOWED_TOOLS`) so the two can diverge without one of
 * them silently inheriting the other's changes.
 */
export const GITHUB_DEFAULT_ALLOWED_TOOLS = [
	// File system
	"Read",
	"Edit",
	"Write",
	"NotebookEdit",

	// Execution
	"Bash",
	"Task",

	// Web
	"WebFetch",
	"WebSearch",

	// Worktree management
	"EnterWorktree",
	"ExitWorktree",

	// User interaction
	"SendMessage",
	"PushNotification",

	// Task lifecycle
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",

	// Scheduling
	"CronCreate",
	"CronDelete",
	"CronList",
	"ScheduleWakeup",

	// Monitoring + discovery
	"Monitor",
	"RemoteTrigger",
	"ToolSearch",
	"Skill",

	// Design sync
	"DesignSync",

	// Workflow orchestration
	"Workflow",

	// Findings reporting
	"ReportFindings",

	// Workspace MCP servers GitHub sessions need
	"mcp__linear",
	"mcp__cyrus-tools",
	"mcp__cyrus-docs",
] as const;

/**
 * Platform identifier used by callers that want to resolve a default list
 * dynamically. Keeps platform-string typos out of the call sites.
 */
export type AllowedToolsPlatform = "linear" | "slack" | "github";

/**
 * Resolve the default allowed-tool list for a platform.
 */
export function getDefaultAllowedTools(
	platform: AllowedToolsPlatform,
): readonly string[] {
	switch (platform) {
		case "linear":
			return LINEAR_DEFAULT_ALLOWED_TOOLS;
		case "slack":
			return SLACK_DEFAULT_ALLOWED_TOOLS;
		case "github":
			return GITHUB_DEFAULT_ALLOWED_TOOLS;
	}
}

/**
 * The Linear MCP server's surface, split by what it does (PON-194).
 *
 * Enumerated live from `https://mcp.linear.app/mcp` (`tools/list`) on
 * 2026-08-28: 57 tools, 35 read and 22 write. The split is kept explicit
 * rather than pattern-matched on `save_`/`delete_` because a wrong guess here
 * either hands a model write access to a client's tracker or silently removes
 * a read it needs.
 *
 * Sessions on client-flow workspaces get READ only. Every message a client
 * receives is composed by the machinery — the scope ask, the delivery summary,
 * elicitations, needs-info, status — so a session has nothing legitimate to
 * write into a client's Linear, and a model-authored write there would bypass
 * every content policy we have.
 */
export const LINEAR_MCP_READ_TOOLS = [
	"mcp__linear__get_attachment",
	"mcp__linear__list_agent_skills",
	"mcp__linear__get_agent_skill",
	"mcp__linear__list_comments",
	"mcp__linear__list_cycles",
	"mcp__linear__get_document",
	"mcp__linear__list_documents",
	"mcp__linear__extract_images",
	"mcp__linear__get_issue",
	"mcp__linear__list_issues",
	"mcp__linear__list_issue_statuses",
	"mcp__linear__get_issue_status",
	"mcp__linear__list_issue_labels",
	"mcp__linear__list_projects",
	"mcp__linear__get_project",
	"mcp__linear__list_project_labels",
	"mcp__linear__list_release_pipelines",
	"mcp__linear__list_releases",
	"mcp__linear__get_release",
	"mcp__linear__list_release_notes",
	"mcp__linear__get_release_note",
	"mcp__linear__get_diff",
	"mcp__linear__list_diffs",
	"mcp__linear__get_diff_threads",
	"mcp__linear__list_milestones",
	"mcp__linear__get_milestone",
	"mcp__linear__list_teams",
	"mcp__linear__get_team",
	"mcp__linear__list_templates",
	"mcp__linear__get_template",
	"mcp__linear__list_users",
	"mcp__linear__get_user",
	"mcp__linear__get_workspace",
	"mcp__linear__search_documentation",
	"mcp__linear__get_status_updates",
] as const;

/** The write half — denied on client-flow workspaces. */
export const LINEAR_MCP_WRITE_TOOLS = [
	"mcp__linear__save_comment",
	"mcp__linear__delete_comment",
	"mcp__linear__save_issue",
	"mcp__linear__share_issue",
	"mcp__linear__unshare_issue",
	"mcp__linear__create_issue_label",
	"mcp__linear__save_document",
	"mcp__linear__save_project",
	"mcp__linear__save_release",
	"mcp__linear__save_release_note",
	"mcp__linear__save_milestone",
	"mcp__linear__save_status_update",
	"mcp__linear__delete_status_update",
	"mcp__linear__prepare_attachment_upload",
	"mcp__linear__create_attachment_from_upload",
	"mcp__linear__create_attachment",
	"mcp__linear__delete_attachment",
	"mcp__linear__save_diff_comment",
	"mcp__linear__resolve_diff_thread",
	"mcp__linear__delete_diff_comment",
	"mcp__linear__submit_diff_review",
	"mcp__linear__merge_diff",
] as const;

/** The whole-server grant the write floor replaces. */
export const LINEAR_MCP_SERVER_PREFIX = "mcp__linear";
