// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SyncReconcileResult } from "@/bindings.gen";

const h = vi.hoisted(() => ({
	mapId: "map-a" as string | null,
	calls: [] as {
		args: unknown[];
		resolve: (value: SyncReconcileResult) => void;
	}[],
	logs: [] as { mapId: string; entry: unknown }[],
}));

vi.mock("@/lib/commands", () => ({
	cmd: {
		remoteMappingClear: async () => {},
		syncReconcile: (...args: unknown[]) =>
			new Promise<SyncReconcileResult>((resolve) => h.calls.push({ args, resolve })),
	},
}));
vi.mock("@/store/store", () => ({
	Store: {
		get: () => ({ mapId: h.mapId, map: h.mapId ? { id: h.mapId } : null }),
	},
}));
vi.mock("@/store/mutation", () => ({
	Mutation: {
		settle: async () => {},
	},
}));

import { createSyncController } from "@/lib/sync/controller";
import type { SyncProvider } from "@/lib/sync/provider";

const result: SyncReconcileResult = {
	pushed: { create: 0, update: 0, delete: 0 },
	pulled: { create: 1, update: 0, delete: 0 },
	adopted: 1,
	conflicts: [],
	mutation: null,
};

function harness() {
	const values = new Map<string, unknown>();
	const kv = {
		get: <T>(key: string, fallback?: T) =>
			values.has(key) ? (values.get(key) as T) : (fallback as T),
		set: (key: string, value: unknown) => void values.set(key, value),
		remove: (key: string) => void values.delete(key),
		keys: () => [...values.keys()],
	};
	(window as unknown as { MMA: unknown }).MMA = {
		storage: () => kv,
		cmd: {
			remoteMappingClear: async () => {},
			syncLogAppend: async (provider: string, mapId: string, entry: unknown) => {
				h.logs.push({ mapId: `${provider}:${mapId}`, entry });
			},
		},
		Store: { get: () => ({ mapId: h.mapId, map: h.mapId ? { id: h.mapId } : null }) },
	};
	const provider = {
		id: "geoguessr",
		label: "Fake",
		icon: "M0 0",
		remoteMapUrl: (id: string) => id,
	} as SyncProvider;
	return createSyncController(provider, "stress-plugin");
}

function remote(remoteMapId: string) {
	return { id: remoteMapId, name: remoteMapId, locationCount: 0 };
}

async function linkMap(controller: ReturnType<typeof createSyncController>, mapId: string) {
	h.mapId = mapId;
	await controller.link(remote(`remote-${mapId}`), null);
}

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	h.mapId = "map-a";
	h.calls = [];
	h.logs = [];
});

describe("sync lifecycle interleavings", () => {
	it.each(["old-first", "new-first"] as const)(
		"keeps the current in-flight guard when map runs settle %s",
		async (order) => {
			const controller = harness();
			await linkMap(controller, "map-a");
			await linkMap(controller, "map-b");

			h.mapId = "map-a";
			const runA = controller.syncNow();
			h.mapId = "map-b";
			const runB = controller.syncNow();
			expect(h.calls.map((c) => c.args[1])).toEqual(["map-a", "map-b"]);

			if (order === "old-first") {
				h.calls[0].resolve(result);
				await expect(runA).rejects.toMatchObject({ name: "AbortError" });
				expect(controller.syncNow()).toBe(runB);
				h.calls[1].resolve(result);
				await runB;
			} else {
				h.calls[1].resolve(result);
				await runB;
				const runC = controller.syncNow();
				expect(h.calls.map((c) => c.args[1])).toEqual(["map-a", "map-b", "map-b"]);
				h.calls[0].resolve(result);
				await expect(runA).rejects.toMatchObject({ name: "AbortError" });
				expect(controller.syncNow()).toBe(runC);
				h.calls[2].resolve(result);
				await runC;
			}
			await flushMicrotasks();
			expect(h.logs.map((l) => l.mapId)).toEqual(
				order === "old-first" ? ["geoguessr:map-b"] : ["geoguessr:map-b", "geoguessr:map-b"],
			);
		},
	);

	it("drains twenty explicit map switches without targeting the wrong map", async () => {
		const controller = harness();
		await linkMap(controller, "map-a");
		await linkMap(controller, "map-b");
		const runs: Promise<unknown>[] = [];
		for (let i = 0; i < 20; i++) {
			h.mapId = i % 2 === 0 ? "map-a" : "map-b";
			runs.push(controller.syncNow());
			expect(h.calls[i].args[1]).toBe(h.mapId);
		}

		for (let i = 19; i >= 0; i--) h.calls[i].resolve(result);
		const outcomes = await Promise.allSettled(runs);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(19);
		await flushMicrotasks();
		expect(h.logs.map((entry) => entry.mapId)).toEqual(["geoguessr:map-b"]);
	});

	it.each(["first-sync", "conflict-resolution"] as const)(
		"rejects queued %s instructions after the active map changes",
		async (instruction) => {
			const controller = harness();
			await linkMap(controller, "map-a");
			await linkMap(controller, "map-b");
			h.mapId = "map-a";
			const active = controller.syncNow();
			const queued =
				instruction === "first-sync"
					? controller.firstSync("merge")
					: controller.resolveConflicts([{ key: "L:1", side: "remote" }]);

			h.mapId = "map-b";
			h.calls[0].resolve(result);
			await active;
			await expect(queued).rejects.toThrow("map changed before sync could run");
			expect(h.calls).toHaveLength(1);
			expect(h.calls[0].args[1]).toBe("map-a");
		},
	);

	it("does not restore a link when unlink drains a delayed reconcile", async () => {
		const controller = harness();
		await linkMap(controller, "map-a");
		const pending = controller.syncNow();
		const unlinking = controller.unlink();
		h.calls[0].resolve(result);
		await Promise.all([pending.catch(() => undefined), unlinking]);
		expect(controller.getLink()).toBeNull();
		expect(controller.allLinks()).toEqual([]);
	});
});
