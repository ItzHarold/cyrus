import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { LinearEventTransport } from "../src/LinearEventTransport.js";

/**
 * PON-111: The webhook HTTP response must be sent before any event
 * processing begins. Linear requires the response within 5 seconds and
 * marks sessions unresponsive when processing delays the reply.
 */
describe("LinearEventTransport - reply before dispatch (PON-111)", () => {
	function setup() {
		const post = vi.fn();
		const fastifyServer = { post } as unknown as FastifyInstance;

		const transport = new LinearEventTransport({
			fastifyServer,
			verificationMode: "proxy",
			secret: "test-secret",
		});
		transport.register();

		const calls = post.mock.calls as Array<
			[string, (request: unknown, reply: unknown) => Promise<void>]
		>;
		const handler = calls.find(([path]) => path === "/linear-webhook")![1];
		return { transport, handler };
	}

	const makeRequest = (body: unknown) => ({
		headers: { authorization: "Bearer test-secret" },
		body,
	});

	it("sends the 200 response before emitting events", async () => {
		const { transport, handler } = setup();
		const order: string[] = [];

		transport.on("event", () => {
			order.push("event");
		});

		const reply = {
			code: vi.fn().mockReturnThis(),
			send: vi.fn().mockImplementation(function (this: unknown) {
				order.push("reply");
				return this;
			}),
		};

		await handler(makeRequest({ type: "AgentSessionEvent" }), reply);

		expect(reply.code).toHaveBeenCalledWith(200);
		expect(order).toEqual(["reply", "event"]);
	});

	it("does not attempt an error response when a listener throws after the reply", async () => {
		const { transport, handler } = setup();

		transport.on("event", () => {
			throw new Error("listener boom");
		});
		// Error listener prevents EventEmitter from rethrowing
		const errorListener = vi.fn();
		transport.on("error", errorListener);

		const reply = {
			code: vi.fn().mockReturnThis(),
			send: vi.fn().mockReturnThis(),
		};

		await handler(makeRequest({ type: "AgentSessionEvent" }), reply);

		// Only the success response was sent — no 500 after the fact
		expect(reply.code).toHaveBeenCalledTimes(1);
		expect(reply.code).toHaveBeenCalledWith(200);
		expect(reply.send).toHaveBeenCalledTimes(1);
		expect(errorListener).toHaveBeenCalled();
	});
});
