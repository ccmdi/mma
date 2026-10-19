// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createElement, act, useEffect } from "react";
import { mount as mountRoot } from "./fixtures/harness";
import { useJob, type Job, type JobContext } from "@/lib/hooks/useJob";

let job: Job<unknown, string>;
const mounts: Array<() => void> = [];

function mount() {
	function Probe() {
		const current = useJob<unknown, string>();
		useEffect(() => {
			job = current;
		}, [current]);
		return null;
	}
	mounts.push(mountRoot(createElement(Probe), { attach: false }).unmount);
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const flush = () => act(async () => {});

describe("useJob", () => {
	it("reports progress and the final result", async () => {
		mount();
		expect(job.status).toBe("idle");
		const d = deferred<void>();
		act(() => {
			void job.run(async ({ report }: JobContext<string>) => {
				report("halfway");
				await d.promise;
				return 42;
			});
		});
		await flush();
		expect(job.status === "loading" && job.progress).toBe("halfway");
		act(() => d.resolve());
		await flush();
		expect(job.ok()).toBe(42);
	});

	it("surfaces a failure as an error state, not a throw", async () => {
		mount();
		act(() => {
			void job.run(async () => {
				throw new Error("boom");
			});
		});
		await flush();
		expect(job.status === "error" && job.error.message).toBe("boom");
	});

	it("run while running is a no-op, so a double click starts one job", async () => {
		mount();
		let starts = 0;
		const d = deferred<void>();
		const work = async () => {
			starts++;
			await d.promise;
		};
		act(() => void job.run(work));
		let second!: Promise<unknown>;
		act(() => {
			second = job.run(work);
		});
		expect(starts).toBe(1);
		expect(job.status).toBe("loading");
		await expect(second).resolves.toMatchObject({ status: "cancelled" });
		act(() => d.resolve());
		await flush();
		expect(starts).toBe(1);
	});

	it("cancel aborts the signal and stops the UI immediately", async () => {
		mount();
		const d = deferred<void>();
		let signal!: AbortSignal;
		act(() => {
			void job.run(async (ctx) => {
				signal = ctx.signal;
				await d.promise;
			});
		});
		expect(job.status).toBe("loading");
		act(() => job.cancel());
		expect(job.status).toBe("cancelled");
		expect(signal.aborted).toBe(true);
	});

	it("a cancelled job cannot write back once it finally settles", async () => {
		mount();
		const d = deferred<number>();
		let report!: (p: string) => void;
		act(() => {
			void job.run(async (ctx) => {
				report = ctx.report;
				return d.promise;
			});
		});
		act(() => job.cancel());
		act(() => report("late progress"));
		act(() => d.resolve(7));
		await flush();
		expect(job.status).toBe("cancelled");
	});

	it("cancelling is not an error", async () => {
		mount();
		const d = deferred<void>();
		act(() => {
			void job.run(async () => {
				await d.promise;
				throw new DOMException("aborted", "AbortError");
			});
		});
		act(() => job.cancel());
		act(() => d.resolve());
		await flush();
		expect(job.status).toBe("cancelled");
	});

	it("unmounting cancels the running job", async () => {
		mount();
		const d = deferred<void>();
		let signal!: AbortSignal;
		act(() => {
			void job.run(async (ctx) => {
				signal = ctx.signal;
				await d.promise;
			});
		});
		expect(signal.aborted).toBe(false);
		for (const unmount of mounts.splice(0)) unmount();
		expect(signal.aborted).toBe(true);
	});

	it("a new run replaces the previous run's error", async () => {
		mount();
		act(() => {
			void job.run(async () => {
				throw new Error("first");
			});
		});
		await flush();
		expect(job.status).toBe("error");
		act(() => {
			void job.run(async () => "ok");
		});
		await flush();
		expect(job.ok()).toBe("ok");
	});
});
