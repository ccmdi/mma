import { multiRemoteBrowser } from "@wdio/globals";
import type { CollabSession, JoinOutcome, Shares } from "@/bindings.gen";
import { createLocation, makeLocs, withApiOn } from "./helpers";

type App = WebdriverIO.Browser;

/** Under the Worker's per-login rate limit of 60 requests a minute. */
const SHARES_POLL_MS = 2_000;

async function open(app: App, map: string) {
	await withApiOn(app, async (api, id) => api._test.openMap(id), map);
	await app.waitUntil(() => withApiOn(app, (api) => api._test.mapOpen.seen.has("markers")), {
		timeoutMsg: `map ${map} never loaded its scene`,
	});
}

/** The open map's rows as comparable keys, so replicas compare without trusting ids. */
async function rows(app: App): Promise<string[]> {
	return withApiOn(app, async (api) =>
		(await api.Query.read({ type: "Everything" }, { kind: "locations" }))
			.map((l) => `${l.lat.toFixed(5)},${l.lng.toFixed(5)},${l.heading}`)
			.sort(),
	);
}

async function waitRows(app: App, name: string, expected: string[]) {
	let last: string[] = [];
	await app
		.waitUntil(async () => {
			last = await rows(app);
			return JSON.stringify(last) === JSON.stringify(expected);
		})
		.catch(() => {
			throw new Error(
				`${name} never converged: has ${JSON.stringify(last)}, wants ${JSON.stringify(expected)}`,
			);
		});
}

async function session(app: App, map: string): Promise<CollabSession | null> {
	return withApiOn(
		app,
		async (api, id) => (await api.cmd.collabSessions()).sessions.find((s) => s.map === id) ?? null,
		map,
	);
}

async function waitLink(app: App, name: string, map: string, state: string) {
	await app.waitUntil(async () => (await session(app, map))?.link.state === state, {
		timeoutMsg: `${name}'s session on ${map} never became ${state}`,
	});
}

async function add(app: App, lat: number, lng: number) {
	await withApiOn(app, async (api, locs) => api.Location.add(locs), [
		createLocation({ lat, lng, heading: 0 }),
	]);
}

async function join(app: App, name: string, map: string): Promise<string> {
	let last: Shares | null = null;
	await app
		.waitUntil(
			async () => {
				last = await withApiOn(app, async (api) => api.cmd.collabShares()).catch(() => last);
				return !!last?.withMe.some((s) => s.host === "host" && s.map === map && s.live);
			},
			{ interval: SHARES_POLL_MS },
		)
		.catch(() => {
			throw new Error(
				`${name} never saw the host live on ${map}: last saw ${JSON.stringify(last)}`,
			);
		});
	const joined = await withApiOn(
		app,
		async (api, id): Promise<JoinOutcome> => api.cmd.collabJoin({ host: "host", map: id }, false),
		map,
	);
	expect(joined.outcome).toBe("following");
	return joined.map;
}

describe("Collab - three apps on one map", () => {
	let host: App;
	let alice: App;
	let bob: App;
	let map = "";
	let aliceCopy = "";
	let bobCopy = "";

	before(async () => {
		[host, alice, bob] = ["host", "alice", "bob"].map((n) => multiRemoteBrowser.getInstance(n));
		for (const app of [host, alice, bob]) {
			await app.waitUntil(() => app.execute(() => window.MMA?.isReady() === true), {
				timeoutMsg: "an app did not boot in time",
			});
		}
		const logins = await Promise.all(
			[host, alice, bob].map((app) =>
				withApiOn(app, async (api) => (await api.cmd.githubMe())?.login ?? null),
			),
		);
		expect(logins).toEqual(["host", "alice", "bob"]);
		map = await withApiOn(
			host,
			async (api) => (await api.cmd.storeCreateMap("Collab E2E", null)).id,
		);
		await open(host, map);
		await withApiOn(
			host,
			async (api, locs) => api.Location.add(locs),
			makeLocs(3, (i) => ({ lat: 10 + i, lng: 20 + i, heading: 0 })),
		);
	});

	after(async () => {
		for (const app of [host, alice, bob]) {
			await withApiOn(app, async (api) => {
				// eslint-disable-next-line local/no-ipc-in-loop -- one session per app at most
				for (const s of (await api.cmd.collabSessions()).sessions) await api.cmd.collabLeave(s.map);
			});
		}
		await withApiOn(host, async (api, id) => api.cmd.collabShare(id, []), map);
	});

	it("host shares and hosts the map; alice and bob join and see the host's rows", async () => {
		await withApiOn(
			host,
			async (api, id) => {
				await api.cmd.collabShare(id, ["alice", "bob"]);
				await api.cmd.collabHost(id);
			},
			map,
		);
		await waitLink(host, "host", map, "live");

		aliceCopy = await join(alice, "alice", map);
		bobCopy = await join(bob, "bob", map);
		const hosted = await rows(host);
		expect(hosted.length).toBe(3);
		for (const [app, name, copy] of [
			[alice, "alice", aliceCopy],
			[bob, "bob", bobCopy],
		] as const) {
			await open(app, copy);
			await waitLink(app, name, copy, "live");
			await waitRows(app, name, hosted);
		}
	});

	it("edits from each app reach the other two", async () => {
		await add(host, 30, 30);
		await add(alice, 31, 31);
		await withApiOn(bob, async (api) => {
			const first = (await api.Query.read({ type: "Everything" }, { kind: "locations" })).find(
				(l) => Math.abs(l.lat - 10) < 1e-9,
			)!;
			await api.Location.update([{ id: first.id, heading: 90 }]);
		});

		const expected = [
			"10.00000,20.00000,90",
			"11.00000,21.00000,0",
			"12.00000,22.00000,0",
			"30.00000,30.00000,0",
			"31.00000,31.00000,0",
		];
		await waitRows(host, "host", expected);
		await waitRows(alice, "alice", expected);
		await waitRows(bob, "bob", expected);
	});

	it("a joiner leaves, misses an edit, rejoins and converges", async () => {
		await withApiOn(alice, async (api, id) => api.cmd.collabLeave(id), aliceCopy);
		expect(await session(alice, aliceCopy)).toBeNull();

		await add(host, 32, 32);
		const hosted = await rows(host);
		await waitRows(bob, "bob", hosted);
		expect(await rows(alice)).not.toEqual(hosted);

		expect(await join(alice, "alice", map)).toBe(aliceCopy);
		await waitLink(alice, "alice", aliceCopy, "live");
		await waitRows(alice, "alice", hosted);

		await add(alice, 33, 33);
		const after = [...hosted, "33.00000,33.00000,0"].sort();
		await waitRows(host, "host", after);
		await waitRows(bob, "bob", after);
	});

	it("the host removes bob from the share: bob is turned away and keeps his copy", async () => {
		const kept = await rows(bob);
		await withApiOn(host, async (api, id) => api.cmd.collabShare(id, ["alice"]), map);
		await waitLink(bob, "bob", bobCopy, "ended");

		await add(host, 34, 34);
		const hosted = await rows(host);
		await waitRows(alice, "alice", hosted);
		expect(await rows(bob)).toEqual(kept);
	});

	it("the host stops hosting: alice's session ends and her copy keeps the rows", async () => {
		const hosted = await rows(host);
		await withApiOn(host, async (api, id) => api.cmd.collabLeave(id), map);
		expect(await session(host, map)).toBeNull();
		await waitLink(alice, "alice", aliceCopy, "ended");
		expect(await rows(alice)).toEqual(hosted);
	});
});
