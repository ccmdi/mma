import { describe, it, expect } from "vitest";
import type { Location } from "@/bindings.gen";
import { LocationFlag } from "@/types";
import * as Remote from "@/plugins/mapMakingSync/remote-types";
import {
	localToNormalized,
	remoteToNormalized,
	localToRemoteInput,
	remoteToLocalFields,
	syncEqual,
} from "@/plugins/mapMakingSync/adapter";

const NAMES = new Map([
	[10, "red"],
	[20, "blue"],
]);
const IDS = new Map([
	["red", 10],
	["blue", 20],
]);
const tagName = (id: number) => NAMES.get(id);
const tagId = (n: string) => IDS.get(n);

function localLoc(over: Partial<Location> = {}): Location {
	return {
		id: 1,
		lat: 0,
		lng: 0,
		heading: 0,
		pitch: 0,
		zoom: 0,
		panoId: null,
		flags: 0,
		tags: [],
		extra: null,
		createdAt: 0,
		modifiedAt: null,
		...over,
	};
}

function remoteLoc(over: Partial<Remote.Location> = {}): Remote.Location {
	return {
		id: 1,
		location: { lat: 0, lng: 0 },
		panoId: null,
		heading: 0,
		pitch: 0,
		zoom: 0,
		createdAt: "1970-01-01T00:00:00Z",
		flags: 0,
		tags: [],
		...over,
	};
}

/** Simulate the server echoing a submitted input back as a full remote Location. */
function echo(input: Remote.LocationInput): Remote.Location {
	return remoteLoc({
		id: input.id,
		location: input.location,
		panoId: input.panoId ?? null,
		heading: input.heading,
		pitch: input.pitch,
		zoom: input.zoom,
		flags: input.flags,
		tags: input.tags,
		author: 1,
		panoDate: "2023-07-01T00:00:00Z",
		createdAt: "2024-01-01T00:00:00Z",
	});
}

describe("mapMakingSync adapter — 1:1 contract", () => {
	it("push round-trips losslessly (local -> remote input -> normalized == local normalized)", () => {
		const L = localLoc({
			lat: 1.5,
			lng: 2.5,
			heading: 90,
			pitch: -5,
			zoom: 1.5,
			panoId: "abc",
			flags: LocationFlag.LoadAsPanoId | LocationFlag.ImportPreview, // virtual bit present
			tags: [20, 10],
		});
		const input = localToRemoteInput(L, 999, tagName);
		expect(input.flags).toBe(LocationFlag.LoadAsPanoId); // virtual stripped
		expect(input.tags).toEqual(["blue", "red"]); // names, sorted
		expect(remoteToNormalized(echo(input))).toEqual(localToNormalized(L, tagName));
	});

	it("pull round-trips losslessly (remote -> local fields -> normalized == remote normalized)", () => {
		const R = remoteLoc({
			location: { lat: 3, lng: 4 },
			heading: 45,
			pitch: 2,
			zoom: null, // unpanned
			panoId: "xyz",
			flags: LocationFlag.Informational,
			tags: ["blue", "red"],
		});
		const fields = remoteToLocalFields(R, tagId);
		expect(fields.zoom).toBe(0); // null -> 0
		expect(fields.tags).toEqual([20, 10]);
		const L = localLoc({ ...fields, id: 7, createdAt: 123, modifiedAt: 99, extra: { foo: 1 } });
		expect(localToNormalized(L, tagName)).toEqual(remoteToNormalized(R));
	});

	it("local-only fields (id/createdAt/modifiedAt/extra) never affect the contract", () => {
		const a = localLoc({ id: 5, createdAt: 1, modifiedAt: 2, extra: { x: 1 } });
		const b = localLoc({ id: 6, createdAt: 999, modifiedAt: null, extra: null });
		expect(syncEqual(localToNormalized(a, tagName), localToNormalized(b, tagName))).toBe(true);
	});

	it("remote-only fields (author/panoDate/createdAt) never affect the contract", () => {
		const base = remoteLoc({ tags: ["red"] });
		const enriched = remoteLoc({
			tags: ["red"],
			author: 42,
			panoDate: "2020-01-01T00:00:00Z",
			createdAt: "2025-05-05T00:00:00Z",
		});
		expect(syncEqual(remoteToNormalized(base), remoteToNormalized(enriched))).toBe(true);
	});

	it("zoom null and 0 are equivalent (unpanned)", () => {
		expect(
			syncEqual(
				remoteToNormalized(remoteLoc({ zoom: null })),
				remoteToNormalized(remoteLoc({ zoom: 0 })),
			),
		).toBe(true);
	});

	it("unknown remote tag names are dropped (caller must pre-create them)", () => {
		const fields = remoteToLocalFields(remoteLoc({ tags: ["red", "ghost"] }), tagId);
		expect(fields.tags).toEqual([10]);
	});

	it("virtual flags never cross to a push payload", () => {
		const L = localLoc({ flags: LocationFlag.SeenOverlay | LocationFlag.Informational });
		expect(localToRemoteInput(L, -1, tagName).flags).toBe(LocationFlag.Informational);
	});
});
