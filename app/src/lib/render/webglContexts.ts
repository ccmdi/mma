import { log } from "@/lib/util/log";

export const WEBGL_CONTEXT_BUDGET = 12;

type GL = WebGLRenderingContext | WebGL2RenderingContext;

const ORIGINAL_GET_CONTEXT = Symbol.for("mma.webgl.getContext");
const prototype = HTMLCanvasElement.prototype as HTMLCanvasElement & {
	[ORIGINAL_GET_CONTEXT]?: HTMLCanvasElement["getContext"];
};
const baseGetContext = prototype[ORIGINAL_GET_CONTEXT] ?? prototype.getContext;
prototype[ORIGINAL_GET_CONTEXT] = baseGetContext;

const live = new Map<HTMLCanvasElement, { gl: GL; createdBy: string }>();
const released = new WeakSet<HTMLCanvasElement>();

function creationSite(): string {
	const frames = (new Error().stack ?? "").split("\n").slice(1);
	const callers = frames.filter((frame) => !/webglContexts|shaderPatch/.test(frame));
	return (
		callers
			.slice(0, 2)
			.map((frame) => frame.trim().replace(/^at\s+/, ""))
			.join(" < ") || "unknown"
	);
}

function describeLive(): string {
	const sites = new Map<string, { attached: number; detached: number }>();
	for (const [canvas, { createdBy }] of live) {
		const site = sites.get(createdBy) ?? { attached: 0, detached: 0 };
		if (canvas.isConnected) site.attached++;
		else site.detached++;
		sites.set(createdBy, site);
	}
	return [...sites]
		.map(([site, { attached, detached }]) => `${attached} attached, ${detached} detached: ${site}`)
		.join("\n");
}

function track(canvas: HTMLCanvasElement, gl: GL) {
	live.set(canvas, { gl, createdBy: creationSite() });
	const lose = gl.getExtension("WEBGL_lose_context");
	if (lose) {
		const loseContext = lose.loseContext.bind(lose);
		lose.loseContext = () => {
			released.add(canvas);
			live.delete(canvas);
			loseContext();
		};
	}
	canvas.addEventListener("webglcontextlost", () => {
		if (!live.delete(canvas) || released.has(canvas)) return;
		log.error(`[webgl] a context was lost without being released; ${live.size} still live`);
	});
}

prototype.getContext = function (this: HTMLCanvasElement, type: string, attrs?: unknown) {
	if (type !== "webgl" && type !== "webgl2") {
		return baseGetContext.call(this, type as "2d", attrs as CanvasRenderingContext2DSettings);
	}
	if (!live.has(this) && live.size >= WEBGL_CONTEXT_BUDGET) {
		const message = `[webgl] context budget of ${WEBGL_CONTEXT_BUDGET} exceeded`;
		log.error(`${message}; live contexts by creator:\n${describeLive()}`);
		throw new Error(message);
	}
	const gl = baseGetContext.call(this, type, {
		...(attrs as WebGLContextAttributes | undefined),
		preserveDrawingBuffer: true,
	}) as GL | null;
	if (gl && !live.has(this)) track(this, gl);
	return gl;
} as HTMLCanvasElement["getContext"];

export function releaseWebglContexts(root: ParentNode) {
	for (const canvas of root.querySelectorAll("canvas")) {
		live.get(canvas)?.gl.getExtension("WEBGL_lose_context")?.loseContext();
	}
}

export function releaseDeckContext(
	deck:
		| {
				props: { gl?: unknown; device?: unknown; canvas?: unknown };
				device?: { gl?: GL } | null;
		  }
		| null
		| undefined,
) {
	if (!deck || deck.props.gl || deck.props.device || deck.props.canvas) return;
	deck.device?.gl?.getExtension("WEBGL_lose_context")?.loseContext();
}
