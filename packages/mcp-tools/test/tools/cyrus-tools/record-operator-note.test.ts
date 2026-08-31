import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCyrusToolsServer } from "../../../src/tools/cyrus-tools/index.js";
import type { OperatorNoteDelivery } from "../../../src/tools/cyrus-tools/record-operator-note.js";
import { registerRecordOperatorNoteTool } from "../../../src/tools/cyrus-tools/record-operator-note.js";

function getHandler(server: McpServer, name: string) {
	const tools = (
		server as unknown as {
			_registeredTools?: Record<
				string,
				{ handler: (args: any) => Promise<any> }
			>;
		}
	)._registeredTools;
	const t = tools?.[name];
	if (!t) throw new Error(`tool ${name} not registered`);
	return t.handler;
}

function hasTool(server: McpServer, name: string): boolean {
	const tools = (
		server as unknown as { _registeredTools?: Record<string, unknown> }
	)._registeredTools;
	return Boolean(tools?.[name]);
}

describe("record_operator_note tool", () => {
	let delivery: OperatorNoteDelivery;
	let server: McpServer;

	beforeEach(() => {
		delivery = { deliver: vi.fn(async () => ({ ok: true as const })) };
		server = new McpServer({ name: "test", version: "0.0.0" });
		registerRecordOperatorNoteTool(server, delivery);
	});

	it("delivers cwd and note to the harness and reports bare success", async () => {
		const handler = getHandler(server, "record_operator_note");
		const result = await handler({
			cwd: "/work/DVV-12",
			note: "## Approach\nRefactor the export module; touch api/export.ts.",
		});

		expect(delivery.deliver).toHaveBeenCalledWith(
			"/work/DVV-12",
			"## Approach\nRefactor the export module; touch api/export.ts.",
			undefined,
			undefined,
		);
		const payload = JSON.parse(result.content[0].text);
		// Bare success only: no ids or internal handles the model could quote
		// onto a client surface.
		expect(payload).toEqual({ success: true });
	});

	it("passes the client_scope capture through to the harness (PON-170)", async () => {
		const handler = getHandler(server, "record_operator_note");
		await handler({
			cwd: "/work/DVV-12",
			note: "internal reading",
			client_scope: "**Outcome** — the export works.",
		});
		expect(delivery.deliver).toHaveBeenCalledWith(
			"/work/DVV-12",
			"internal reading",
			"**Outcome** — the export works.",
			undefined,
		);
	});

	it("surfaces a delivery failure as an explicit NOT-recorded error", async () => {
		delivery.deliver = vi.fn(async () => ({
			ok: false as const,
			error: "no session matches cwd=/nowhere",
		}));
		server = new McpServer({ name: "test", version: "0.0.0" });
		registerRecordOperatorNoteTool(server, delivery);

		const handler = getHandler(server, "record_operator_note");
		const result = await handler({ cwd: "/nowhere", note: "reading" });
		const payload = JSON.parse(result.content[0].text);
		expect(payload.success).toBe(false);
		expect(payload.error).toContain("NOT recorded");
		expect(payload.error).toContain("no session matches");
	});

	it("is registered by createCyrusToolsServer only when the hook is provided", () => {
		const linearClient = {} as any;
		const withHook = createCyrusToolsServer(linearClient, {
			operatorNotes: delivery,
		});
		const withoutHook = createCyrusToolsServer(linearClient, {});
		expect(hasTool(withHook, "record_operator_note")).toBe(true);
		expect(hasTool(withoutHook, "record_operator_note")).toBe(false);
	});
});

describe("the client summary hand-over (PON-235)", () => {
	it("passes the recorded client summary through to the harness", async () => {
		// The client's text stops being scraped from a free-form final
		// message — twice a run trailed one with a line to the reviewer and
		// the client received it. Handing it over deliberately removes the
		// trap, the way PON-196 moved the scope into the elicitation.
		const delivery: OperatorNoteDelivery = {
			deliver: vi.fn(async () => ({ ok: true as const })),
		};
		const server = new McpServer({ name: "test", version: "0.0.0" });
		registerRecordOperatorNoteTool(server, delivery);

		await getHandler(
			server,
			"record_operator_note",
		)({
			cwd: "/work/DVV-12",
			note: "internal reading",
			client_summary: "Your export now includes the order date.",
		});

		expect(delivery.deliver).toHaveBeenCalledWith(
			"/work/DVV-12",
			"internal reading",
			undefined,
			"Your export now includes the order date.",
		);
	});
});
