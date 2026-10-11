import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startGgStub, GG_STUB_CONTROL_PATH, type GgStub } from "../e2e/ggStubServer";
import {
	startSvStub,
	SV_STUB_FAULTS_PATH,
	SV_STUB_TIMELINE_PATH,
	type SvStub,
} from "../e2e/svStubServer";
import type { NetEntry } from "../e2e/svLatency";

const servers: (GgStub | SvStub)[] = [];
const origin = (server: GgStub | SvStub) => `http://127.0.0.1:${server.port}`;
const jsonRequest = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});
async function gg() {
	const server = await startGgStub(0, () => {});
	servers.push(server);
	return origin(server);
}
async function sv() {
	const server = await startSvStub(0, () => {});
	servers.push(server);
	return server;
}
beforeEach(() => {
	for (const name of [
		"MMA_E2E_SV_REPLAY",
		"MMA_E2E_SV_HIDDEN_CAPTURE",
		"MMA_E2E_SV_MAX_INFLIGHT",
		"MMA_E2E_SV_FAULTS",
	])
		vi.stubEnv(name, "");
});
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	vi.unstubAllEnvs();
});
const draftsPath = "/api/v4/user-maps/drafts";
async function createDraft(base: string, name = "fixture") {
	const response = await fetch(base + draftsPath, jsonRequest("POST", { name, mode: "custom" }));
	expect(response.status).toBe(200);
	return ((await response.json()) as { id: string }).id;
}

describe("GeoGuessr stub preserves remote sync guarantees", () => {
	it("round trips Unicode metadata and coordinates at successive versions", async () => {
		const base = await gg();
		const id = await createDraft(base, "雪 🌍");
		expect(await fetch(base + draftsPath).then((r) => r.json())).toEqual([
			{ slug: id, name: "雪 🌍", mode: "custom" },
		]);
		const url = base + draftsPath + "/" + id;
		expect(await fetch(url).then((r) => r.json())).toEqual({
			name: "雪 🌍",
			mode: "custom",
			version: 0,
			coordinates: null,
		});
		const coordinates = [{ lat: 0, lng: -180, heading: 0, extra: { tag: "雪" } }];
		for (const [version, customCoordinates] of [
			[1, coordinates],
			[2, []],
		] as const) {
			const response = await fetch(url, jsonRequest("PUT", { version, customCoordinates }));
			expect(response.status).toBe(200);
			await response.text();
			expect(await fetch(url).then((r) => r.json())).toEqual({
				name: "雪 🌍",
				mode: "custom",
				version,
				coordinates: customCoordinates,
			});
		}
	});
	it.each([0, 2, -1])("rejects version %i without mutating the draft", async (version) => {
		const base = await gg();
		const url = base + draftsPath + "/" + (await createDraft(base));
		const before = await fetch(url).then((r) => r.json());
		const response = await fetch(
			url,
			jsonRequest("PUT", { version, customCoordinates: [{ lat: 1, lng: 2 }] }),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ message: "version mismatch" });
		expect(await fetch(url).then((r) => r.json())).toEqual(before);
	});
	it("allows exactly one of two concurrent writes at the same version", async () => {
		const base = await gg();
		const url = base + draftsPath + "/" + (await createDraft(base));
		const candidates = [[{ lat: 1, lng: 2 }], [{ lat: 3, lng: 4 }]];
		const responses = await Promise.all(
			candidates.map((customCoordinates) =>
				fetch(url, jsonRequest("PUT", { version: 1, customCoordinates })),
			),
		);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
		await Promise.all(responses.map((r) => r.text()));
		expect(await fetch(url).then((r) => r.json())).toMatchObject({
			version: 1,
			coordinates: candidates[responses.findIndex((r) => r.status === 200)],
		});
	});
	it("allocates unique draft IDs under concurrent creates", async () => {
		const base = await gg();
		const ids = await Promise.all(
			Array.from({ length: 32 }, (_, i) => createDraft(base, `map-${i}`)),
		);
		expect(new Set(ids).size).toBe(32);
		expect(ids.every((id) => /^[0-9a-f]{24}$/.test(id))).toBe(true);
		const listed = (await fetch(base + draftsPath).then((r) => r.json())) as {
			slug: string;
			name: string;
		}[];
		expect(listed.map((d) => d.slug).sort()).toEqual([...ids].sort());
		expect(listed.map((d) => d.name).sort()).toEqual(
			Array.from({ length: 32 }, (_, i) => `map-${i}`).sort(),
		);
	});
	it("isolates drafts and request logs between servers", async () => {
		const first = await gg();
		const second = await gg();
		await createDraft(first);
		expect(await fetch(second + GG_STUB_CONTROL_PATH).then((r) => r.json())).toEqual({ hits: [] });
		expect(await fetch(second + draftsPath).then((r) => r.json())).toEqual([]);
	});
	it("captures complete UTF-8 bodies and cookies and clears logs without deleting drafts", async () => {
		const base = await gg();
		const id = await createDraft(base);
		const body = JSON.stringify({ text: "雪 🌍", values: [0, null, false] });
		const response = await fetch(base + "/api/v4/echo?key=a%26b", {
			method: "PUT",
			headers: { cookie: "_ncfa=fixture" },
			body,
		});
		expect(await response.json()).toEqual({
			path: "/api/v4/echo",
			query: "key=a%26b",
			cookie: "_ncfa=fixture",
			method: "PUT",
			body,
		});
		expect(await fetch(base + GG_STUB_CONTROL_PATH).then((r) => r.json())).toMatchObject({
			hits: [
				{ method: "POST", url: draftsPath },
				{ method: "PUT", url: "/api/v4/echo?key=a%26b", cookie: "_ncfa=fixture", body },
			],
		});
		expect(
			await fetch(base + GG_STUB_CONTROL_PATH, { method: "DELETE" }).then((r) => r.json()),
		).toEqual({ hits: [] });
		expect(await fetch(base + draftsPath + "/" + id).then((r) => r.json())).toMatchObject({
			version: 0,
		});
	});
	it("propagates a non-success upstream response", async () => {
		const response = await fetch((await gg()) + "/api/v4/teapot");
		expect(response.status).toBe(418);
		expect(await response.json()).toEqual({ message: "upstream said no" });
	});
});

describe("Street View stub control and scale accounting", () => {
	const searchPath = "/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch";
	const searchBody =
		'[["apiv3"],[[null,null,48.8584,2.2945],50],[null,null,null,null,null,null,null,null,[2]],[[1,2,3,4,8,6]]]';
	const search = (server: SvStub) =>
		fetch(origin(server) + searchPath, { method: "POST", body: searchBody });
	it("consumes and resets a deterministic fault sequence through HTTP", async () => {
		const server = await sv();
		const configure = () =>
			fetch(
				origin(server) + SV_STUB_FAULTS_PATH,
				jsonRequest("POST", { "48.8584,2.2945": [503, 429] }),
			).then((r) => r.text());
		await configure();
		for (const expected of [503, 429, 200]) {
			const response = await search(server);
			expect(response.status).toBe(expected);
			await response.text();
		}
		await configure();
		const response = await search(server);
		expect(response.status).toBe(503);
		await response.text();
		expect(server.served()).toBe(4);
	});
	it("rejects malformed controls and continues serving requests", async () => {
		const server = await sv();
		const response = await fetch(origin(server) + SV_STUB_FAULTS_PATH, {
			method: "POST",
			body: "{",
		});
		expect(response.status).toBe(400);
		await response.text();
		expect(server.served()).toBe(0);
		const next = await search(server);
		expect(next.status).toBe(200);
		expect(await next.text()).toContain("MOCK_48.8584_2.2945");
	});
	it("counts requests beyond the log cap and separates control traffic", async () => {
		const server = await sv();
		const base = origin(server);
		const statuses = await Promise.all(
			Array.from({ length: 225 }, (_, i) =>
				fetch(base + `/unknown-${i}`).then(async (r) => {
					await r.text();
					return r.status;
				}),
			),
		);
		expect(statuses).toEqual(Array(225).fill(404));
		expect(server.served()).toBe(225);
		expect(server.hits).toHaveLength(200);
		expect(new Set(server.hits).size).toBe(200);
		expect(await fetch(base + SV_STUB_TIMELINE_PATH).then((r) => r.json())).toEqual([]);
		expect(server.served()).toBe(225);
	});
	it("clears only the timeline and leaves aggregate accounting intact", async () => {
		const server = await sv();
		const response = await search(server);
		await response.text();
		const timeline = (await fetch(origin(server) + SV_STUB_TIMELINE_PATH).then((r) =>
			r.json(),
		)) as NetEntry[];
		expect(timeline).toHaveLength(1);
		expect(timeline[0].kind).toBe("SingleImageSearch");
		expect(timeline[0].end).toBeGreaterThanOrEqual(timeline[0].start);
		expect(
			await fetch(origin(server) + SV_STUB_TIMELINE_PATH, { method: "DELETE" }).then((r) =>
				r.json(),
			),
		).toEqual([]);
		expect(server.served()).toBe(1);
		expect(server.hits).toHaveLength(1);
	});
});
