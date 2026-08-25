import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Operator-note channel (PON-169 / client-flow R1).
 *
 * The scope-confirm gate keeps the client-facing confirmation deliverable-
 * framed: what the client receives, not how it gets built. The internal
 * reading — approach, files, risks, interpretations — still has to exist
 * somewhere the operator can see it BEFORE approving anything, so the gate
 * instructs the session to record it here first. The harness stores it on
 * the issue's operator record and pushes it into the cockpit mirror; it
 * never touches a tenant surface.
 */

export interface OperatorNoteDelivery {
	/**
	 * Deliver a note to the harness. `cwd` resolves which session (and so
	 * which issue) the note belongs to — same resolution contract as
	 * `log_failure_mode`.
	 */
	deliver(
		cwd: string,
		note: string,
		clientScope?: string,
	): Promise<{ ok: true } | { ok: false; error: string }>;
}

export function registerRecordOperatorNoteTool(
	server: McpServer,
	options: OperatorNoteDelivery,
): void {
	server.registerTool(
		"record_operator_note",
		{
			description:
				"Record the internal reading of the current issue for the operator: implementation approach, files and areas you expect to touch, risks, and any interpretation you made. This is operator-side only — it is never shown on the issue and never reaches the client, so write it in full internal detail. Call it before posting a client-facing scope confirmation, and call it again with an updated reading whenever the scope changes. The latest note replaces the previous one.",
			inputSchema: {
				cwd: z
					.string()
					.describe(
						"The current working directory of this agent session. Used to resolve the session internally.",
					),
				note: z
					.string()
					.min(1)
					.describe(
						"The internal reading, as Markdown: approach, files/areas to touch, risks, interpretations. Full internal detail — this is for the operator, not the client.",
					),
				client_scope: z
					.string()
					.optional()
					.describe(
						"The exact deliverable-framed scope text you will post to the client, verbatim. Recording it here lets the operator later see precisely what the client approved.",
					),
			},
		},
		async ({ cwd, note, client_scope }) => {
			const result = await options.deliver(cwd, note, client_scope);
			if (!result.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: `The operator note was NOT recorded: ${result.error}`,
							}),
						},
					],
				};
			}
			// No ids or internal handles are echoed back (same rationale as
			// log_failure_mode): the operator-side record must stay invisible
			// to the client, and anything we hand the model can end up quoted.
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ success: true }),
					},
				],
			};
		},
	);
}
