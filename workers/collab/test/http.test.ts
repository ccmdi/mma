import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyToken } from "../src/auth";
import worker from "../src/index";
import { SECRET, call, connect, fakeEnv } from "./runtime";

afterEach(() => {
	vi.unstubAllGlobals();
});

function github(response: Response) {
	const fetch = vi.fn(async () => response);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

function session(h: ReturnType<typeof fakeEnv>, token: string) {
	return worker.fetch(
		new Request("https://collab.test/session", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": "1.2.3.4" },
		}),
		h.env,
	);
}

describe("session", () => {
	it("trades an accepted github token for a worker token", async () => {
		const h = fakeEnv();
		const fetch = github(new Response(JSON.stringify({ login: "OctoCat" })));
		const res = await session(h, "gho_secret");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { token: string; login: string; exp: number };
		expect(body.login).toBe("octocat");
		expect(await verifyToken(SECRET, body.token)).toEqual({ login: "octocat", exp: body.exp });

		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.github.com/user");
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer gho_secret");
	});

	it("checks the token against the github api the environment names", async () => {
		const h = fakeEnv();
		const fetch = github(new Response(JSON.stringify({ login: "alice" })));
		const res = await session(
			{ ...h, env: { ...h.env, GITHUB_API: "http://127.0.0.1:4602" } },
			"t",
		);
		expect(res.status).toBe(200);
		const [url] = fetch.mock.calls[0] as unknown as [string];
		expect(url).toBe("http://127.0.0.1:4602/user");
	});

	it("refuses a token github rejects", async () => {
		const h = fakeEnv();
		github(new Response("{}", { status: 401 }));
		const res = await session(h, "gho_bad");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "github rejected the token" });
	});

	it("never stores the github token", async () => {
		const h = fakeEnv();
		github(new Response(JSON.stringify({ login: "octocat" })));
		const res = await session(h, "gho_secret");
		expect(h.kv.writes).toBe(0);
		expect(await res.text()).not.toContain("gho_secret");
	});

	it("refuses every other route without a worker token", async () => {
		const h = fakeEnv();
		expect((await call(h, null, "GET", "/shares")).status).toBe(401);
		const forged = await worker.fetch(
			new Request("https://collab.test/shares", { headers: { Authorization: "Bearer gho_x" } }),
			h.env,
		);
		expect(forged.status).toBe(401);
	});
});

describe("share directory", () => {
	it("indexes a share under its owner and every invited login", async () => {
		const h = fakeEnv();
		const put = await call(h, "host", "PUT", "/shares/map1", {
			name: "My map",
			logins: ["Alice", "bob", "alice"],
		});
		expect(put.status).toBe(200);
		expect(await put.json()).toEqual({
			map: "map1",
			name: "My map",
			logins: ["alice", "bob"],
			invite: null,
		});

		expect(await (await call(h, "host", "GET", "/shares")).json()).toEqual({
			mine: [{ map: "map1", name: "My map", logins: ["alice", "bob"], invite: null }],
			withMe: [],
		});
		expect(await (await call(h, "alice", "GET", "/shares")).json()).toEqual({
			mine: [],
			withMe: [{ host: "host", map: "map1", name: "My map", live: false }],
		});
	});

	it("replaces the previous share and drops removed logins from their inbox", async () => {
		const h = fakeEnv();
		await call(h, "host", "PUT", "/shares/map1", { name: "One", logins: ["alice", "bob"] });
		await call(h, "host", "PUT", "/shares/map1", { name: "Renamed", logins: ["alice"] });

		expect([...h.directory.keys()].sort()).toEqual(["inbox:alice:host:map1", "share:host:map1"]);
		expect(await (await call(h, "bob", "GET", "/shares")).json()).toEqual({ mine: [], withMe: [] });
		const mine = (await (await call(h, "host", "GET", "/shares")).json()) as {
			mine: { name: string }[];
		};
		expect(mine.mine.map((m) => m.name)).toEqual(["Renamed"]);
	});

	it("unshares one map and keeps the others", async () => {
		const h = fakeEnv();
		await call(h, "host", "PUT", "/shares/map1", { name: "One", logins: ["alice"] });
		await call(h, "host", "PUT", "/shares/map2", { name: "Two", logins: ["alice"] });
		expect((await call(h, "host", "DELETE", "/shares/map1")).status).toBe(204);

		const listed = async (login: string) =>
			(await (await call(h, login, "GET", "/shares")).json()) as {
				mine: { map: string }[];
				withMe: { map: string }[];
			};
		expect((await listed("host")).mine.map((m) => m.map)).toEqual(["map2"]);
		expect((await listed("alice")).withMe.map((m) => m.map)).toEqual(["map2"]);

		await call(h, "host", "DELETE", "/shares/map2");
		expect([...h.directory.keys()]).toEqual([]);
	});

	it("keeps every share made at the same time", async () => {
		const h = fakeEnv();
		await Promise.all([
			call(h, "host", "PUT", "/shares/map1", { name: "One", logins: ["alice"] }),
			call(h, "host", "PUT", "/shares/map2", { name: "Two", logins: [] }),
			call(h, "other", "PUT", "/shares/map3", { name: "Three", logins: ["alice"] }),
		]);
		const listed = async (login: string) =>
			(await (await call(h, login, "GET", "/shares")).json()) as {
				mine: { map: string }[];
				withMe: { map: string }[];
			};
		expect((await listed("host")).mine.map((m) => m.map)).toEqual(["map1", "map2"]);
		expect((await listed("alice")).withMe.map((m) => m.map)).toEqual(["map1", "map3"]);
	});

	it("reports a share live while its host is connected", async () => {
		const h = fakeEnv();
		await call(h, "host", "PUT", "/shares/map1", { name: "One", logins: ["alice"] });
		const host = await connect(h, "host", "host", "map1", "host");
		const live = async () =>
			((await (await call(h, "alice", "GET", "/shares")).json()) as { withMe: { live: boolean }[] })
				.withMe[0].live;
		expect(await live()).toBe(true);
		await host.close();
		expect(await live()).toBe(false);
	});

	it("rejects malformed shares", async () => {
		const h = fakeEnv();
		const put = (path: string, body: unknown) => call(h, "host", "PUT", path, body);
		expect((await put("/shares/map1", { name: "x" })).status).toBe(400);
		expect((await put("/shares/map1", { name: " ", logins: [] })).status).toBe(400);
		expect((await put("/shares/map1", { name: "x", logins: ["not a login"] })).status).toBe(400);
		const many = Array.from({ length: 51 }, (_, i) => `user${i}`);
		expect((await put("/shares/map1", { name: "x", logins: many })).status).toBe(400);
		expect((await put("/shares/bad%20id", { name: "x", logins: [] })).status).toBe(400);
		expect((await put("/shares/%E0", { name: "x", logins: [] })).status).toBe(400);
		expect(h.kv.writes).toBe(0);
	});
});

describe("rate limit", () => {
	it("caps http requests per login", async () => {
		const h = fakeEnv(3);
		for (let i = 0; i < 3; i++) expect((await call(h, "alice", "GET", "/shares")).status).toBe(200);
		expect((await call(h, "alice", "GET", "/shares")).status).toBe(429);
		expect((await call(h, "bob", "GET", "/shares")).status).toBe(200);
	});

	it("never limits socket messages", async () => {
		const h = fakeEnv(3);
		await call(h, "host", "PUT", "/shares/map1", { name: "One", logins: ["alice"] });
		const host = await connect(h, "host", "host", "map1", "host");
		const alice = await connect(h, "alice", "host", "map1", "join");
		for (let i = 0; i < 100; i++)
			await alice.send({ type: "signal", data: { candidate: `c${i}` } });
		expect(host.received.filter((m) => m.type === "signal")).toHaveLength(100);
		expect((await call(h, "host", "GET", "/shares")).status).toBe(200);
		expect((await call(h, "host", "GET", "/shares")).status).toBe(429);
	});
});
