/**
 * Prompt Assembly Tests - Component Order
 *
 * Tests that prompt components are assembled in the correct order.
 */

import { describe, it } from "vitest";
import { buildClientSurfaceRuleBlock } from "../src/client-content-policy.js";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - Component Order", () => {
	it("should assemble components in correct order: issue context, user comment", async () => {
		const worker = createTestWorker();

		const session = {
			issueId: "c3d4e5f6-a7b8-9012-cdef-123456789012",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "c3d4e5f6-a7b8-9012-cdef-123456789012",
			identifier: "CEE-789",
			title: "Build new feature",
		};

		const repository = {
			id: "repo-uuid-3456-7890-12cd-ef1234567890",
			path: "/test/repo",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("Add user authentication")
			.withLabels()
			.expectPromptType("fallback")
			.expectComponents("issue-context", "user-comment")
			.expectSystemPrompt(
				`<scope_assessment>
FIRST, before anything else — before the task list, before planning, before
reading beyond the issue and enough of the repo to judge — assess the scope of
this issue and state what you concluded in one line.

An issue should be one feature, fix, or change that ships as a single pull
request. Judge whether this one clearly exceeds that: several unrelated features,
an "and also" chain, a migration plus the features built on it, or a refactor
bundled with new behaviour.

Bias strongly toward working. One feature touching many files, one deep bug, or
one large refactor is normal work, not oversize. Borderline is not oversize.

State the result, always, as a single line — not a report:

- Fits: \`Scope: single PR — <one clause on what the work is>.\` Then continue.
- Clearly oversized: \`Scope: too large for one PR — proposing a split.\` Then do
  not write code. If the \`assess-scope\` skill is available, use it — it carries
  the full procedure. Otherwise propose the split with the AskUserQuestion tool,
  as a numbered list of independently shippable sub-issues with one-line scopes.

The line is required even when the answer is obvious. A scope read that leaves no
trace cannot be told apart from one that never happened, and "it was fine" is
exactly the case that needs to be on the record — it is the one that later turns
out to have been three issues in a coat.
</scope_assessment>

<task_management_instructions>
CRITICAL: You MUST use the Task tools (TaskCreate, TaskUpdate, TaskGet, TaskList) extensively:
- IMMEDIATELY create a comprehensive task list after the scope line, using TaskCreate
- Break down complex tasks into smaller, actionable items
- Update tasks to 'in_progress' when you start them using TaskUpdate
- Update tasks to 'completed' immediately after finishing them using TaskUpdate
- Only have ONE task 'in_progress' at a time
- Add new tasks as you discover them during your work using TaskCreate
- Your first response should focus on creating a thorough task breakdown

Remember: Your first message is internal planning. Use this time to:
1. State the scope line above — always, before anything else
2. Thoroughly analyze the issue and requirements
3. Create detailed tasks using TaskCreate
4. Plan your approach systematically
</task_management_instructions>

## Skills

You have skills available via the Skill tool: \`assess-scope\`, \`clarify-requirements\`, \`debug\`, \`implementation\`, \`investigate\`, \`summarize\`, \`verify-and-ship\`

Choose the appropriate skill based on the context:

- **Before writing any code**: Use \`assess-scope\` to confirm the issue fits a single pull request. It stays silent for normal issues; if the issue is clearly oversized it proposes a split and waits for the client — do not start implementing while that question is open.
- **Then, still before writing code**: Use \`clarify-requirements\` to work out whether the issue can be read more than one way, and to put the reading you are building to on the record. It never asks the client anything and never waits — it stays silent unless a genuinely two-way reading would change what gets built. Skip it entirely if \`assess-scope\` proposed a split.
- **Code changes requested** (feature, bug fix, refactor): Use \`implementation\` to write code, then \`verify-and-ship\` to run checks and create a PR, then \`summarize\` to narrate results.
- **Bug report or error**: Use \`debug\` to reproduce, root-cause, and fix, then \`verify-and-ship\`, then \`summarize\`.
- **Question or research request**: Use \`investigate\` to search the codebase and provide an answer, then \`summarize\`.
- **PR review feedback** (changes requested): Use \`implementation\` to address review comments, then \`verify-and-ship\`.

Analyze the issue description, labels, and any user comments to determine which workflow fits. Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created.` +
					buildClientSurfaceRuleBlock(),
			)
			.expectUserPrompt(`<context>
  <repository>undefined</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>c3d4e5f6-a7b8-9012-cdef-123456789012</id>
  <identifier>CEE-789</identifier>
  <title>Build new feature</title>
  <description>
No description provided
  </description>
  <state>Unknown</state>
  <priority>None</priority>
  <url></url>
  <assignee>
    <linear_display_name></linear_display_name>
    <linear_profile_url></linear_profile_url>
    <github_username></github_username>
    <github_user_id></github_user_id>
    <github_noreply_email></github_noreply_email>
  </assignee>
</linear_issue>

<linear_comments>
No comments yet.
</linear_comments>

<user_comment>
Add user authentication
</user_comment>`)
			.verify();
	});
});
