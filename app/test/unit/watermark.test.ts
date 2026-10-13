import { describe, it, expect } from "vitest";
import { watermark } from "@/lib/util/watermark";

const settled = async <T>(p: Promise<T>) => {
	let done = false;
	void p.then(() => (done = true));
	await Promise.resolve();
	await Promise.resolve();
	return done;
};

describe("watermark", () => {
	it("a wait at or below the mark resolves at once with the late answer", async () => {
		const w = watermark((v) => `late ${v}`);
		w.pass(5, "five");
		await expect(w.reached(3)).resolves.toBe("late 3");
		await expect(w.reached(5)).resolves.toBe("late 5");
	});

	it("a wait ahead of the mark resolves when a pass reaches it, not before", async () => {
		const w = watermark(() => "late");
		const ahead = w.reached(4);
		w.pass(3, "three");
		expect(await settled(ahead)).toBe(false);
		w.pass(4, "four");
		await expect(ahead).resolves.toBe("four");
	});

	it("the mark never moves down on a pass", () => {
		const w = watermark(() => 0);
		w.pass(9, 9);
		w.pass(2, 2);
		expect(w.version()).toBe(9);
	});

	it("a reset releases every pending wait, whatever its version", async () => {
		const w = watermark((v) => -v);
		const near = w.reached(2);
		const far = w.reached(100);
		w.reset(0, (v) => v * 10);
		await expect(near).resolves.toBe(20);
		await expect(far).resolves.toBe(1000);
	});

	it("a reset moves the mark to its version, down included", async () => {
		const w = watermark(() => "late");
		w.pass(30, "thirty");
		w.reset(2, () => "reset");
		expect(w.version()).toBe(2);
		expect(await settled(w.reached(3))).toBe(false);
	});
});
