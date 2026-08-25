// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useJob, type Job, type JobContext } from "@/lib/hooks/useJob";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let job: Job<unknown, unknown>;
const roots: Root[] = [];

function mount<R, P>(fn: (ctx: JobContext<P>) => Promise<R>) {
	function Probe() {
		job = useJob(fn) as Job<unknown, unknown>;
		return null;
	}
	const root = createRoot(document.createElement("div"));
	act(() => root.render(createElement(Probe)));
	roots.push(root);
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

afterEach(() => {
	act(() => roots.splice(0).forEach((r) => r.unmount()));
});

describe("useJob", () => {
	it("reports progress and the final result", async () => {
		mount(async ({ report }: JobContext<string>) => {
			report("halfway");
			return 42;
		});
		expect(job.running).toBe(false);

		act(() => job.run());
		await flush();

		expect(job.running).toBe(false);
		expect(job.result).toBe(42);
		expect(job.error).toBeNull();
	});

	it("surfaces a failure as a message, not a throw", async () => {
		mount(async () => {
			throw new Error("boom");
		});
		act(() => job.run());
		await flush();

		expect(job.error).toBe("boom");
		expect(job.running).toBe(false);
	});

	it("run while running is a no-op, so a double click starts one job", async () => {
		let starts = 0;
		const d = deferred<void>();
		mount(async () => {
			starts++;
			await d.promise;
		});

		act(() => job.run());
		act(() => job.run());
		expect(starts).toBe(1);
		expect(job.running).toBe(true);

		act(() => d.resolve());
		await flush();
		expect(starts).toBe(1);
	});

	it("cancel aborts the signal and stops the UI immediately", async () => {
		const d = deferred<void>();
		let signal!: AbortSignal;
		mount(async (ctx: JobContext<string>) => {
			signal = ctx.signal;
			await d.promise;
		});

		act(() => job.run());
		expect(job.running).toBe(true);

		act(() => job.cancel());
		expect(job.running).toBe(false);
		expect(signal.aborted).toBe(true);
	});

	it("a cancelled job cannot write back once it finally settles", async () => {
		const d = deferred<number>();
		let report!: (p: string) => void;
		mount(async (ctx: JobContext<string>) => {
			report = ctx.report;
			return d.promise;
		});

		act(() => job.run());
		act(() => job.cancel());

		act(() => report("late progress"));
		act(() => d.resolve(7));
		await flush();

		expect(job.progress).toBeNull();
		expect(job.result).toBeNull();
		expect(job.running).toBe(false);
	});

	it("cancelling is not an error", async () => {
		const d = deferred<void>();
		mount(async ({ signal }: JobContext<string>) => {
			await d.promise;
			throw new DOMException("aborted", "AbortError");
			void signal;
		});

		act(() => job.run());
		act(() => job.cancel());
		act(() => d.resolve());
		await flush();

		expect(job.error).toBeNull();
	});

	it("unmounting cancels the running job", async () => {
		const d = deferred<void>();
		let signal!: AbortSignal;
		mount(async (ctx: JobContext<string>) => {
			signal = ctx.signal;
			await d.promise;
		});

		act(() => job.run());
		expect(signal.aborted).toBe(false);

		act(() => roots.splice(0).forEach((r) => r.unmount()));
		expect(signal.aborted).toBe(true);
	});

	it("a new run clears the previous run's error and result", async () => {
		let shouldFail = true;
		mount(async () => {
			if (shouldFail) throw new Error("first");
			return "ok";
		});

		act(() => job.run());
		await flush();
		expect(job.error).toBe("first");

		shouldFail = false;
		act(() => job.run());
		await flush();
		expect(job.error).toBeNull();
		expect(job.result).toBe("ok");
	});
});
