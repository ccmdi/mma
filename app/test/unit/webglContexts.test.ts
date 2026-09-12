// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const requested = new WeakMap<HTMLCanvasElement, WebGLContextAttributes | undefined>();
const contexts = new WeakMap<HTMLCanvasElement, object>();

function fakeGetContext(this: HTMLCanvasElement, type: string, attrs?: WebGLContextAttributes) {
	if (type !== "webgl" && type !== "webgl2") return null;
	requested.set(this, attrs);
	const existing = contexts.get(this);
	if (existing) return existing;
	const lose = {
		loseContext: () => this.dispatchEvent(new Event("webglcontextlost")),
	};
	const gl = {
		getExtension: (name: string) => (name === "WEBGL_lose_context" ? lose : null),
	};
	contexts.set(this, gl);
	return gl;
}

async function fresh() {
	vi.resetModules();
	HTMLCanvasElement.prototype.getContext = fakeGetContext as HTMLCanvasElement["getContext"];
	delete (HTMLCanvasElement.prototype as unknown as Record<symbol, unknown>)[
		Symbol.for("mma.webgl.getContext")
	];
	const gpu = await import("@/lib/render/webglContexts");
	const { log } = await import("@/lib/util/log");
	return { ...gpu, log };
}

function fill(count: number): HTMLCanvasElement[] {
	return Array.from({ length: count }, () => {
		const canvas = document.createElement("canvas");
		canvas.getContext("webgl2");
		return canvas;
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("the WebGL context budget", () => {
	it("forces preserveDrawingBuffer so the live frame can be read back", async () => {
		await fresh();
		const [canvas] = fill(1);
		expect(requested.get(canvas)?.preserveDrawingBuffer).toBe(true);
	});

	it("throws and logs once a new context would go past the budget", async () => {
		const { WEBGL_CONTEXT_BUDGET, log } = await fresh();
		fill(WEBGL_CONTEXT_BUDGET);
		expect(() => fill(1)).toThrow(`context budget of ${WEBGL_CONTEXT_BUDGET} exceeded`);
		expect(log.error).toHaveBeenCalledOnce();
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining(`0 attached, ${WEBGL_CONTEXT_BUDGET} detached`),
		);
	});

	it("counts a canvas once however often it asks for its context", async () => {
		const { WEBGL_CONTEXT_BUDGET } = await fresh();
		const [canvas] = fill(1);
		canvas.getContext("webgl2");
		canvas.getContext("webgl2");
		expect(() => fill(WEBGL_CONTEXT_BUDGET - 1)).not.toThrow();
	});

	it("frees a slot when its owner releases the context", async () => {
		const { WEBGL_CONTEXT_BUDGET, releaseWebglContexts, log } = await fresh();
		const host = document.createElement("div");
		const [owned] = fill(1);
		host.appendChild(owned);
		fill(WEBGL_CONTEXT_BUDGET - 1);
		releaseWebglContexts(host);
		expect(() => fill(1)).not.toThrow();
		expect(log.error).not.toHaveBeenCalled();
	});

	it("reports a context the browser evicted without a release", async () => {
		const { log } = await fresh();
		const [canvas] = fill(1);
		canvas.dispatchEvent(new Event("webglcontextlost"));
		expect(log.error).toHaveBeenCalledWith(expect.stringContaining("lost without being released"));
	});

	it("leaves 2D contexts out of the count", async () => {
		const { WEBGL_CONTEXT_BUDGET } = await fresh();
		for (let i = 0; i < WEBGL_CONTEXT_BUDGET * 2; i++) {
			document.createElement("canvas").getContext("2d");
		}
		expect(() => fill(WEBGL_CONTEXT_BUDGET)).not.toThrow();
	});
});

describe("deck.gl contexts", () => {
	it("releases the context a deck created for itself", async () => {
		const { WEBGL_CONTEXT_BUDGET, releaseDeckContext, log } = await fresh();
		const [canvas] = fill(1);
		const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
		fill(WEBGL_CONTEXT_BUDGET - 1);
		releaseDeckContext({ props: {}, device: { gl } });
		expect(() => fill(1)).not.toThrow();
		expect(log.error).not.toHaveBeenCalled();
	});

	it("leaves a context the deck borrowed from its basemap alone", async () => {
		const { WEBGL_CONTEXT_BUDGET, releaseDeckContext } = await fresh();
		const [canvas] = fill(1);
		const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
		fill(WEBGL_CONTEXT_BUDGET - 1);
		releaseDeckContext({ props: { gl }, device: { gl } });
		expect(() => fill(1)).toThrow();
	});
});
