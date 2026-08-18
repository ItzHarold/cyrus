<scope_assessment>
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

- Fits: `Scope: single PR — <one clause on what the work is>.` Then continue.
- Clearly oversized: `Scope: too large for one PR — proposing a split.` Then do
  not write code. If the `assess-scope` skill is available, use it — it carries
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