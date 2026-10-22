import { beforeEach, describe, expect, it } from "vitest";

import { REPLACED } from "../src/room";
import { call, connect, fakeEnv, type Harness } from "./runtime";

let h: Harness;

beforeEach(async () => {
	h = fakeEnv();
	await call(h, "host", "PUT", "/shares/map1", { name: "One", logins: ["alice", "bob"] });
});

const hostIn = () => connect(h, "host", "host", "map1", "host");
const joinIn = (login: string) => connect(h, login, "host", "map1", "join");
const offer = { offer: "v=0" };
const answer = { answer: "v=0" };

function roomStatus(login: string, role: string, map = "map1", upgrade = true) {
	return call(
		h,
		login,
		"GET",
		`/room/host/${map}?role=${role}`,
		undefined,
		upgrade ? { Upgrade: "websocket" } : {},
	).then((r) => r.status);
}

function peerOf(message: Record<string, unknown>): string {
	return message.peer as string;
}

describe("admission", () => {
	it("refuses a join when the map is not shared with the caller", async () => {
		expect(await roomStatus("mallory", "join")).toBe(403);
		expect(await roomStatus("alice", "join", "map2")).toBe(404);
	});

	it("refuses to host for anyone but the host", async () => {
		expect(await roomStatus("alice", "host")).toBe(403);
	});

	it("refuses without a token, a role or an upgrade", async () => {
		const anonymous = await call(h, null, "GET", "/room/host/map1?role=join", undefined, {
			Upgrade: "websocket",
		});
		expect(anonymous.status).toBe(401);
		expect(await roomStatus("alice", "spectate")).toBe(400);
		expect(await roomStatus("alice", "join", "map1", false)).toBe(426);
	});

	it("answers ping with pong without waking the room", () => {
		const { state } = h.roomFor("host:map1");
		expect(state.autoResponse).toMatchObject({ request: "ping", response: "pong" });
	});
});

describe("presence", () => {
	it("tells a joiner the host is away, then pushes the host arriving", async () => {
		const alice = await joinIn("alice");
		expect(alice.received).toEqual([{ type: "host", live: false }]);

		const host = await hostIn();
		expect(alice.received.at(-1)).toEqual({ type: "host", live: true });
		expect(host.received).toEqual([{ type: "joined", peer: expect.any(String), login: "alice" }]);
	});

	it("tells the host who joins", async () => {
		const host = await hostIn();
		const alice = await joinIn("alice");
		expect(alice.received).toEqual([{ type: "host", live: true }]);
		expect(host.received.at(-1)).toMatchObject({ type: "joined", login: "alice" });
	});

	it("tells joiners when the host goes", async () => {
		const host = await hostIn();
		const alice = await joinIn("alice");
		await host.close();
		expect(alice.received.at(-1)).toEqual({ type: "host", live: false });
	});

	it("starts empty after everyone leaves", async () => {
		const host = await hostIn();
		const alice = await joinIn("alice");
		await alice.send({ type: "signal", data: offer });
		await alice.close();
		await host.close();

		const again = await hostIn();
		expect(again.received).toEqual([]);
	});
});

describe("signals", () => {
	it("forwards a joiner's signal to the host with who sent it", async () => {
		const host = await hostIn();
		const alice = await joinIn("alice");
		const peer = peerOf(host.received[0]);

		await alice.send({ type: "signal", data: offer });
		expect(host.received.at(-1)).toEqual({
			type: "signal",
			from: peer,
			login: "alice",
			guest: false,
			data: offer,
		});
	});

	it("forwards the host's signal to the joiner it names only", async () => {
		const host = await hostIn();
		const alice = await joinIn("alice");
		const bob = await joinIn("bob");
		const peer = peerOf(host.received[0]);

		await host.send({ type: "signal", to: peer, data: answer });
		await host.send({ type: "signal", to: peer, data: { candidate: "candidate:1" } });
		await host.send({ type: "signal", to: peer, data: "restart" });
		expect(alice.received.slice(1)).toEqual([
			{ type: "signal", data: answer },
			{ type: "signal", data: { candidate: "candidate:1" } },
			{ type: "signal", data: "restart" },
		]);
		expect(bob.received).toEqual([{ type: "host", live: true }]);
	});

	it("drops a joiner's signal when no host is connected, and does not replay it later", async () => {
		const alice = await joinIn("alice");
		await alice.send({ type: "signal", data: offer });
		const host = await hostIn();
		expect(host.received.map((m) => m.type)).toEqual(["joined"]);
	});

	it("drops a signal to a peer that is not there", async () => {
		const host = await hostIn();
		const alice = await joinIn("alice");
		await host.send({ type: "signal", to: "nobody", data: answer });
		expect(alice.received).toEqual([{ type: "host", live: true }]);
	});

	it("drops frames that are not signals", async () => {
		const host = await hostIn();
		const alice = await joinIn("alice");
		const before = host.received.length;
		for (const frame of [
			"not json",
			"null",
			{ type: "chat", data: offer },
			{ type: "signal" },
			{ type: "signal", data: { candidate: "x".repeat(70 * 1024) } },
		]) {
			await alice.send(frame);
		}
		expect(host.received.length).toBe(before);
	});
});

describe("replacement", () => {
	it("a second host socket replaces the first", async () => {
		const first = await hostIn();
		const alice = await joinIn("alice");
		const second = await hostIn();

		expect(first.closed).toEqual({ code: REPLACED, reason: "replaced" });
		expect(second.received).toEqual([{ type: "joined", peer: expect.any(String), login: "alice" }]);

		await alice.send({ type: "signal", data: offer });
		expect(second.received.at(-1)).toMatchObject({ type: "signal", data: offer });
		expect(first.received.some((m) => m.type === "signal")).toBe(false);

		await first.send({ type: "signal", to: peerOf(second.received[0]), data: answer });
		expect(alice.received.some((m) => m.type === "signal")).toBe(false);

		await first.close();
		expect(alice.received.at(-1)).toEqual({ type: "host", live: true });
	});

	it("a second join socket for the same login replaces the first", async () => {
		const host = await hostIn();
		const first = await joinIn("alice");
		const oldPeer = peerOf(host.received[0]);
		const second = await joinIn("alice");
		const newPeer = peerOf(host.received.at(-1)!);

		expect(first.closed).toEqual({ code: REPLACED, reason: "replaced" });
		expect(newPeer).not.toBe(oldPeer);
		expect(host.received.slice(1)).toEqual([{ type: "joined", peer: newPeer, login: "alice" }]);

		await first.send({ type: "signal", data: offer });
		expect(host.received.some((m) => m.type === "signal")).toBe(false);

		await host.send({ type: "signal", to: oldPeer, data: answer });
		await host.send({ type: "signal", to: newPeer, data: answer });
		expect(first.received.some((m) => m.type === "signal")).toBe(false);
		expect(second.received.at(-1)).toEqual({ type: "signal", data: answer });
	});

	it("keeps joins from different logins side by side", async () => {
		const host = await hostIn();
		const alice = await joinIn("alice");
		const bob = await joinIn("bob");
		expect(alice.closed).toBeNull();
		expect(bob.closed).toBeNull();
		expect(host.received.map((m) => m.login)).toEqual(["alice", "bob"]);
	});
});
