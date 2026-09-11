// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

/** In-memory MMA with a plugin KV and the map-making key commands over a fake credential store. */
function makeMma(opts: { kvKey?: string; storedKey?: string | null } = {}) {
	const storage = new Map<string, unknown>();
	if (opts.kvKey !== undefined) storage.set("apiKey", opts.kvKey);
	let stored: string | null = opts.storedKey ?? null;

	const kv = {
		get: <T>(k: string, fallback?: T): T =>
			storage.has(k) ? (storage.get(k) as T) : (fallback as T),
		set: (k: string, v: unknown) => void storage.set(k, v),
		remove: (k: string) => void storage.delete(k),
		keys: () => [...storage.keys()],
	};

	const cmd = {
		mapMakingHasKey: vi.fn(async () => stored !== null),
		mapMakingSetKey: vi.fn(async (key: string | null) => {
			stored = key;
		}),
	};

	(window as unknown as { MMA: unknown }).MMA = { storage: () => kv, cmd };
	return { storage, cmd, storedKey: () => stored };
}

/** A fresh module instance, so the in-process key-presence flag does not leak between cases. */
async function loadController() {
	vi.resetModules();
	return await import("@/plugins/mapMakingSync/controller");
}

beforeEach(() => {
	localStorage.clear();
});

describe("adoptStoredKey", () => {
	it("does nothing when neither side holds a key", async () => {
		const mma = makeMma();
		const c = await loadController();

		await c.adoptStoredKey();

		expect(mma.cmd.mapMakingSetKey).not.toHaveBeenCalled();
		expect(mma.storedKey()).toBeNull();
		expect(c.hasKey()).toBe(false);
	});

	it("moves a plugin-storage key into the credential store and forgets it", async () => {
		const mma = makeMma({ kvKey: "legacy-key" });
		const c = await loadController();

		await c.adoptStoredKey();

		expect(mma.storedKey()).toBe("legacy-key");
		expect(mma.storage.has("apiKey")).toBe(false);
		expect(c.hasKey()).toBe(true);
	});

	it("leaves plugin storage untouched when it holds no key", async () => {
		const mma = makeMma({ storedKey: "rust-key" });
		const c = await loadController();

		await c.adoptStoredKey();

		expect(mma.cmd.mapMakingSetKey).not.toHaveBeenCalled();
		expect(mma.storedKey()).toBe("rust-key");
		expect(c.hasKey()).toBe(true);
	});

	it("keeps the credential store's key when both sides hold one, and still clears storage", async () => {
		const mma = makeMma({ kvKey: "legacy-key", storedKey: "rust-key" });
		const c = await loadController();

		await c.adoptStoredKey();

		expect(mma.cmd.mapMakingSetKey).not.toHaveBeenCalled();
		expect(mma.storedKey()).toBe("rust-key");
		expect(mma.storage.has("apiKey")).toBe(false);
		expect(c.hasKey()).toBe(true);
	});

	it("ignores a blank plugin-storage key but still clears it", async () => {
		const mma = makeMma({ kvKey: "   " });
		const c = await loadController();

		await c.adoptStoredKey();

		expect(mma.cmd.mapMakingSetKey).not.toHaveBeenCalled();
		expect(mma.storedKey()).toBeNull();
		expect(mma.storage.has("apiKey")).toBe(false);
		expect(c.hasKey()).toBe(false);
	});
});

describe("setKey", () => {
	it("trims and tracks presence; an empty key clears the credential store", async () => {
		const mma = makeMma();
		const c = await loadController();

		await c.setKey("  k  ");
		expect(mma.storedKey()).toBe("k");
		expect(c.hasKey()).toBe(true);

		await c.setKey("");
		expect(mma.storedKey()).toBeNull();
		expect(c.hasKey()).toBe(false);
	});
});
