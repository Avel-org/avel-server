import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorEnvelope } from "../../src/contract";
import { MAX_BODY_BYTES } from "../../src/middleware/body-limit";
import { BASE_URL, buildApp } from "./support";

/** A sign-in body padded with spaces to exactly `bytes` bytes. */
function signInBody(bytes: number): string {
	const json = JSON.stringify({ provider: "github", callbackURL: "/" });
	return json.slice(0, -1) + " ".repeat(bytes - json.length) + "}";
}

function chunked(body: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(body);
	const step = 64 * 1024;
	let at = 0;
	return new ReadableStream({
		pull(c) {
			if (at >= bytes.byteLength) return c.close();
			c.enqueue(bytes.slice(at, at + step));
			at += step;
		},
	});
}

// Over a real socket, because the limit rebuilds the request and
// @hono/node-server's stand-in Request is what once broke every route.
describe("the request body cap", () => {
	let server: ServerType;
	let base: string;

	// One server per test: a refusal answers before the body is read, and
	// Node then resets that socket, so a later fetch must not reuse it.
	beforeEach(async () => {
		const { app } = buildApp();
		await new Promise<void>((resolve) => {
			server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
		});
		base = `http://localhost:${(server.address() as AddressInfo).port}`;
	});

	afterEach(
		() =>
			new Promise<void>((resolve) => {
				(server as Server).closeAllConnections();
				server.close(() => resolve());
			}),
	);

	const signIn = (body: string | ReadableStream<Uint8Array>) =>
		fetch(`${base}/api/auth/sign-in/social`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: BASE_URL },
			body,
			...(typeof body === "string" ? {} : { duplex: "half" }),
		} as RequestInit);

	async function refusedTooLarge(res: Response) {
		expect(res.status).toBe(400);
		const body = errorEnvelope.parse(await res.json());
		expect(body.error.code).toBe("VALIDATION_FAILED");
		expect(body.error.message).toBe(
			`The request body is larger than ${MAX_BODY_BYTES} bytes`,
		);
		expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
	}

	it("refuses an unauthenticated sign-in body over the cap, declared by length", async () => {
		await refusedTooLarge(await signIn(signInBody(MAX_BODY_BYTES + 1)));
	});

	it("refuses one over the cap sent chunked, with no length declared", async () => {
		await refusedTooLarge(
			await signIn(chunked(signInBody(MAX_BODY_BYTES + 1))),
		);
	});

	it("lets a body at the cap through to Better Auth, by length or chunked", async () => {
		for (const body of [
			signInBody(MAX_BODY_BYTES),
			chunked(signInBody(MAX_BODY_BYTES)),
		]) {
			const res = await signIn(body);
			expect(res.status).toBe(200);
			const { url } = (await res.json()) as { url: string };
			expect(url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
		}
	});

	it("refuses an oversized body on a contract route before the session check", async () => {
		const res = await fetch(`${base}/api/clients`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: signInBody(MAX_BODY_BYTES + 1),
		});
		await refusedTooLarge(res);
	});

	it("leaves the Drive's upload route to its own cap", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/intakes/x/files?name=big.md", {
			method: "POST",
			headers: { "content-type": "text/plain", origin: BASE_URL },
			body: "x".repeat(MAX_BODY_BYTES + 1),
		});
		// No session, so the operator check answers, not the body cap.
		expect(res.status).toBe(401);
		expect(errorEnvelope.parse(await res.json()).error.code).toBe(
			"UNAUTHENTICATED",
		);
	});
});
