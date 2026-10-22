import { describe, it, expect, afterEach } from "vitest";
import { MapHost } from "@/lib/map/mapHost";

const host = (id: string) => ({ id }) as unknown as MapHost;

afterEach(() => MapHost.set(null));

describe("MapHost.wait", () => {
	it("resolves immediately once a host is set", async () => {
		MapHost.set(host("a"));
		await expect(MapHost.wait()).resolves.toBe(MapHost.get());
	});

	it("resolves a waiter that predates the host", async () => {
		const pending = MapHost.wait();
		const h = host("b");
		MapHost.set(h);
		await expect(pending).resolves.toBe(h);
	});

	it("still settles a waiter across an intervening close", async () => {
		const pending = MapHost.wait();
		MapHost.set(null);
		const h = host("c");
		MapHost.set(h);
		await expect(pending).resolves.toBe(h);
	});

	it("gives every waiter across a close the same host", async () => {
		const first = MapHost.wait();
		MapHost.set(null);
		const second = MapHost.wait();
		const h = host("d");
		MapHost.set(h);
		expect(await Promise.all([first, second])).toEqual([h, h]);
	});
});
