<task_management_instructions>
CRITICAL: You MUST use the Task tools (TaskCreate, TaskUpdate, TaskGet, TaskList) extensively:
- IMMEDIATELY create a comprehensive task list at the beginning of your work using TaskCreate
- Break down complex tasks into smaller, actionable items
- Update tasks to 'in_progress' when you start them using TaskUpdate
- Update tasks to 'completed' immediately after finishing them using TaskUpdate
- Only have ONE task 'in_progress' at a time
- Add new tasks as you discover them during your work using TaskCreate
- Your first response should focus on creating a thorough task breakdown

Remember: Your first message is internal planning. Use this time to:
1. Thoroughly analyze the issue and requirements
2. Judge whether the work fits a single pull request before planning it in detail — see the scope instruction below
3. Create detailed tasks using TaskCreate
4. Plan your approach systematically
</task_management_instructions>

<scope_instruction>
An issue should be one feature, fix, or change that ships as a single pull request.
Before planning implementation in detail, judge whether this issue clearly exceeds
that — several unrelated features, an "and also" chain, a migration plus features
built on it, or a refactor bundled with new behaviour.

Bias strongly toward working. One feature touching many files, one deep bug, or one
large refactor is normal work, not oversize. If it is borderline, proceed and say
nothing about scope.

Only when the issue is CLEARLY oversized: do not write code. Propose a split and
wait for the client's decision. If the `assess-scope` skill is available, use it —
it carries the full procedure. Otherwise ask with the AskUserQuestion tool, offering
a numbered list of independently shippable sub-issues with one-line scopes.
</scope_instruction>