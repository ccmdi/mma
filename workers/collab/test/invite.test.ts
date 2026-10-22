import { beforeEach, describe, expect, it } from "vitest";

import { TOKEN_TTL, verifyToken } from "../src/auth";
import worker from "../src/index";
import { SECRET, call, connect, fakeEnv, type Harness } from "./runtime";

const WEEK = 7 * 24 * 60 * 60;
const ALPHABET = /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const GUEST_ONLY = { error: "a guest can only join the map it was invited to" };

let h: Harness;

beforeEach(async () => {
	h = fakeEnv();
	await call(h, "host", "PUT", "/shares/map1", { name: "One", logins: ["alice"] });
	await call(h, "host", "PUT", "/shares/map2", { name: "Two", logins: ["alice"] });
});

const now = () => Math.floor(Date.now() / 1000);

async function invite(map = "map1"): Promise<{ code: string; exp: number }> {
	return (await call(h, "host", "PUT", `/invites/${map}`)).json() as Promise<{
		code: string;
		exp: number;
	}>;
}

const KEY = "0123456789abcdef0123456789abcdef";

function redeem(code: unknown, { key = KEY as unknown, ip = "1.2.3.4" } = {}) {
	return worker.fetch(
		new Request("https://collab.test/guest", {
			method: "POST",
			headers: { "CF-Connecting-IP": ip },
			body: JSON.stringify({ code, key }),
		}),
		h.env,
	);
}

interface Guest {
	token: string;
	login: string;
	exp: number;
	invited: { host: string; map: string; name: string };
}

async function guest(code: string, key = KEY): Promise<Guest> {
	return (await redeem(code, { key })).json() as Promise<Guest>;
}

function asGuest(
	g: Guest,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
) {
	return call(h, null, method, path, body, { Authorization: `Bearer ${g.token}`, ...headers });
}

function joinAs(g: Guest, path = "/room/host/map1?role=join") {
	return asGuest(g, "GET", path, undefined, { Upgrade: "websocket" });
}

describe("invites", () => {
	it("creates a code that lives a week under both keys", async () => {
		const res = await call(h, "host", "PUT", "/invites/map1");
		expect(res.status).toBe(200);
		const { code, exp } = (await res.json()) as { code: string; exp: number };
		expect(code).toMatch(ALPHABET);
		expect(exp).toBeGreaterThanOrEqual(now() + WEEK - 1);
		expect(exp).toBeLessThanOrEqual(now() + WEEK);

		expect(JSON.parse(h.kv.store.get(`invite:${code}`)!)).toEqual({
			host: "host",
			map: "map1",
			exp,
		});
		expect(h.kv.store.get("invite-of:host:map1")).toBe(code);
		expect(h.kv.ttls.get(`invite:${code}`)).toBe(WEEK);
		expect(h.kv.ttls.get("invite-of:host:map1")).toBe(WEEK);
	});

	it("hands back the live invite instead of making another", async () => {
		const first = await invite();
		const writes = h.kv.writes;
		expect(await invite()).toEqual(first);
		expect(h.kv.writes).toBe(writes);
		expect((await invite("map2")).code).not.toBe(first.code);
	});

	it("makes a fresh code once the old one expired", async () => {
		const first = await invite();
		h.kv.store.set(
			`invite:${first.code}`,
			JSON.stringify({ host: "host", map: "map1", exp: now() - 1 }),
		);
		expect((await invite()).code).not.toBe(first.code);
	});

	it("refuses to invite to a map that is not shared", async () => {
		const res = await call(h, "host", "PUT", "/invites/map9");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "share the map before inviting guests" });
		expect((await call(h, "alice", "PUT", "/invites/map1")).status).toBe(404);
	});

	it("deletes both keys", async () => {
		const { code } = await invite();
		const res = await call(h, "host", "DELETE", "/invites/map1");
		expect(res.status).toBe(204);
		expect(h.kv.store.has(`invite:${code}`)).toBe(false);
		expect(h.kv.store.has("invite-of:host:map1")).toBe(false);
	});

	it("drops the invite when the map is unshared", async () => {
		const { code } = await invite();
		await call(h, "host", "DELETE", "/shares/map1");
		expect(h.kv.store.has(`invite:${code}`)).toBe(false);
		expect(h.kv.store.has("invite-of:host:map1")).toBe(false);
	});

	it("lists each shared map's live code", async () => {
		const { code } = await invite();
		const { mine } = (await (await call(h, "host", "GET", "/shares")).json()) as {
			mine: { map: string; invite: string | null }[];
		};
		expect(mine.map((m) => [m.map, m.invite])).toEqual([
			["map1", code],
			["map2", null],
		]);
	});

	it("rejects a bad map id", async () => {
		expect((await call(h, "host", "PUT", "/invites/bad%20id")).status).toBe(400);
	});
});

describe("redeeming a code", () => {
	it("mints a guest token for the invited map", async () => {
		const { code } = await invite();
		const res = await redeem(code);
		expect(res.status).toBe(200);
		const g = (await res.json()) as Guest;
		expect(g.login).toMatch(/^guest--[0-9a-f]{6}$/);
		expect(g.invited).toEqual({ host: "host", map: "map1", name: "One" });
		expect(g.exp).toBeLessThanOrEqual(now() + TOKEN_TTL);
		expect(g.exp).toBeGreaterThanOrEqual(now() + TOKEN_TTL - 1);
		expect(await verifyToken(SECRET, g.token)).toEqual({
			login: g.login,
			exp: g.exp,
			guest: { host: "host", map: "map1", code },
		});
	});

	it("knows the holder of one key by one login, however often it redeems the code", async () => {
		const { code } = await invite();
		const first = await guest(code);
		const again = await guest(code);
		const other = await guest(code, "fedcba9876543210fedcba9876543210");
		expect(again.login).toBe(first.login);
		expect(other.login).not.toBe(first.login);
		expect(other.login).toMatch(/^guest--[0-9a-f]{6}$/);
	});

	it("refuses a missing or malformed key", async () => {
		const { code } = await invite();
		for (const key of [null, 42, "short", "x".repeat(129), "has spaces in it, sixteen+"]) {
			expect((await redeem(code, { key })).status).toBe(400);
		}
	});

	it("never outlives the invite", async () => {
		const code = "abcd2345";
		const exp = now() + 600;
		await h.kv.put(`invite:${code}`, JSON.stringify({ host: "host", map: "map1", exp }));
		await h.kv.put("invite-of:host:map1", code);
		expect((await guest(code)).exp).toBe(exp);
	});

	it("accepts a code typed with capitals, spaces and dashes", async () => {
		const { code } = await invite();
		const typed = ` ${code.slice(0, 4).toUpperCase()}-${code.slice(4)} `;
		expect((await redeem(typed)).status).toBe(200);
	});

	it("refuses an unknown, expired or malformed code", async () => {
		const expired = "zzzz2345";
		await h.kv.put(
			`invite:${expired}`,
			JSON.stringify({ host: "host", map: "map1", exp: now() - 1 }),
		);
		for (const code of ["abcd2345", expired, "", "il0o1234", "x".repeat(200)]) {
			const res = await redeem(code);
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ error: "that invite code is not valid" });
		}
		expect((await redeem(42)).status).toBe(400);
	});

	it("rate limits by ip without a token", async () => {
		h = fakeEnv(3);
		for (let i = 0; i < 3; i++) expect((await redeem("abcd2345")).status).toBe(404);
		expect((await redeem("abcd2345")).status).toBe(429);
		expect((await redeem("abcd2345", { ip: "5.6.7.8" })).status).toBe(404);
	});
});

describe("guests", () => {
	it("see only the map they were invited to", async () => {
		await invite("map2");
		const g = await guest((await invite()).code);
		expect(await (await asGuest(g, "GET", "/shares")).json()).toEqual({
			mine: [],
			withMe: [{ host: "host", map: "map1", name: "One", live: false }],
		});
	});

	it("see nothing once the invite is off", async () => {
		const g = await guest((await invite()).code);
		await call(h, "host", "DELETE", "/invites/map1");
		expect(await (await asGuest(g, "GET", "/shares")).json()).toEqual({ mine: [], withMe: [] });
	});

	it("join the room under their guest login", async () => {
		const host = await connect(h, "host", "host", "map1", "host");
		const g = await guest((await invite()).code);
		expect((await joinAs(g)).status).toBe(101);
		expect(host.received.at(-1)).toMatchObject({ type: "joined", login: g.login });
	});

	it("reach the host as guests", async () => {
		const host = await connect(h, "host", "host", "map1", "host");
		const g = await guest((await invite()).code);
		const joined = (await joinAs(g)) as unknown as { webSocket: { peer: unknown } };
		const signal = JSON.stringify({ type: "signal", data: { offer: "v=0" } });
		await h.roomFor("host:map1").room.webSocketMessage(joined.webSocket.peer as WebSocket, signal);
		expect(host.received.at(-1)).toMatchObject({ type: "signal", login: g.login, guest: true });
	});

	it("are refused once the host turns the invite off", async () => {
		const g = await guest((await invite()).code);
		await call(h, "host", "DELETE", "/invites/map1");
		await invite();
		const res = await joinAs(g);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "the host turned this invite off" });
	});

	it("are refused on other maps, as host, and on every other route", async () => {
		await invite("map2");
		const g = await guest((await invite()).code);
		const refusals = [
			joinAs(g, "/room/host/map2?role=join"),
			joinAs(g, "/room/alice/map1?role=join"),
			joinAs(g, "/room/host/map1?role=host"),
			asGuest(g, "PUT", "/shares/map1", { name: "Mine", logins: [] }),
			asGuest(g, "DELETE", "/shares/map1"),
			asGuest(g, "PUT", "/invites/map1"),
			asGuest(g, "DELETE", "/invites/map1"),
			asGuest(g, "GET", "/nowhere"),
		];
		for (const res of await Promise.all(refusals)) {
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual(GUEST_ONLY);
		}
		expect(h.kv.store.has("invite-of:host:map1")).toBe(true);
	});
});
