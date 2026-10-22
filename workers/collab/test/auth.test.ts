import { describe, expect, it } from "vitest";

import { Base64url } from "../../shared/base64url";
import { TOKEN_TTL, mintToken, verifyToken } from "../src/auth";

const SECRET = "test-secret";

async function signed(claims: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(claims));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
	return `${Base64url.encode(bytes)}.${Base64url.encode(signature)}`;
}

describe("worker token", () => {
	it("round trips", async () => {
		const minted = await mintToken(SECRET, "octocat");
		expect(minted.login).toBe("octocat");
		expect(minted.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
		expect(minted.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + TOKEN_TTL);

		const claims = await verifyToken(SECRET, minted.token);
		expect(claims).toEqual({ login: "octocat", exp: minted.exp });
	});

	it("rejects a tampered login", async () => {
		const { token } = await mintToken(SECRET, "octocat");
		const [, signature] = token.split(".");
		const forged = `${Base64url.encode(
			new TextEncoder().encode(JSON.stringify({ login: "admin", exp: 9999999999 })),
		)}.${signature}`;
		expect(await verifyToken(SECRET, forged)).toBeNull();
	});

	it("rejects a tampered signature", async () => {
		const { token } = await mintToken(SECRET, "octocat");
		const [claims, signature] = token.split(".");
		const flipped = (signature.startsWith("A") ? "B" : "A") + signature.slice(1);
		expect(await verifyToken(SECRET, `${claims}.${flipped}`)).toBeNull();
	});

	it("rejects another secret", async () => {
		const { token } = await mintToken(SECRET, "octocat");
		expect(await verifyToken("other-secret", token)).toBeNull();
	});

	it("rejects an expired token", async () => {
		const token = await signed({ login: "octocat", exp: Math.floor(Date.now() / 1000) - 1 });
		expect(await verifyToken(SECRET, token)).toBeNull();
	});

	it("rejects malformed tokens", async () => {
		for (const token of ["", "nodot", "a.b.c", ".", "!!!.!!!"]) {
			expect(await verifyToken(SECRET, token)).toBeNull();
		}
	});
});

describe("guest token", () => {
	const guest = { host: "host", map: "map1", code: "abcd2345" };

	it("round trips its invite", async () => {
		const minted = await mintToken(SECRET, "guest--abc123", guest, 60);
		expect(minted.guest).toEqual(guest);
		expect(minted.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60);
		expect(await verifyToken(SECRET, minted.token)).toEqual({
			login: "guest--abc123",
			exp: minted.exp,
			guest,
		});
	});

	it("leaves the guest off a member token", async () => {
		const minted = await mintToken(SECRET, "octocat");
		expect("guest" in minted).toBe(false);
		expect("guest" in (await verifyToken(SECRET, minted.token))!).toBe(false);
	});

	it("rejects a malformed guest claim", async () => {
		const exp = Math.floor(Date.now() / 1000) + 60;
		for (const bad of [null, "host", { host: "host", map: "map1" }, { ...guest, code: 1 }]) {
			expect(await verifyToken(SECRET, await signed({ login: "x", exp, guest: bad }))).toBeNull();
		}
	});
});

describe("helpers", () => {
	it("base64url survives every byte", () => {
		const bytes = new Uint8Array(256).map((_, i) => i);
		expect(Base64url.decode(Base64url.encode(bytes))).toEqual(bytes);
	});
});
