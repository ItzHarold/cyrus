// Two variables the repo never documents — exactly the shape that costs an
// afternoon when a client is asked to "send your env vars".
const key = process.env.POSTMARK_TOKEN;
export const sender = process.env.NOTIFY_FROM_EMAIL ?? "noreply@example.com";
export function send() {
	return key;
}
