import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactJSXRuntime from "react/jsx-runtime";
import * as ReactJSXDevRuntime from "react/jsx-dev-runtime";

const eager: Record<string, unknown> = {
	react: React,
	"react-dom": ReactDOM,
	"react/jsx-runtime": ReactJSXRuntime,
	"react/jsx-dev-runtime": ReactJSXDevRuntime,
};

// deck.gl/luma.gl are kept out of the initial bundle (split into their own chunk,
// shared with the lazily-loaded MapEditor). Preloaded before user plugins import,
// so plugin-side synchronous __mma_require still resolves them.
const lazy: Record<string, () => Promise<unknown>> = {
	"@deck.gl/core": () => import("@deck.gl/core"),
	"@deck.gl/layers": () => import("@deck.gl/layers"),
	"@deck.gl/google-maps": () => import("@deck.gl/google-maps"),
	"@luma.gl/core": () => import("@luma.gl/core"),
	"@luma.gl/engine": () => import("@luma.gl/engine"),
	"@luma.gl/shadertools": () => import("@luma.gl/shadertools"),
	"@luma.gl/webgl": () => import("@luma.gl/webgl"),
};

const loaded: Record<string, unknown> = {};

export function mmaRequire(id: string): unknown {
	if (id in eager) return eager[id];
	if (id in loaded) return loaded[id];
	if (id in lazy) {
		throw new Error(
			`Module "${id}" is lazy-loaded. ` +
				`Call await MMA.preloadModules(["${id}"]) in your activate() first.`,
		);
	}
	throw new Error(`Module "${id}" is not available as an MMA external.`);
}

export async function preloadModules(ids: string[]): Promise<void> {
	await Promise.all(
		ids.map(async (id) => {
			if (id in eager || id in loaded) return;
			const loader = lazy[id];
			if (!loader) throw new Error(`Module "${id}" is not available as an MMA external.`);
			loaded[id] = await loader();
		}),
	);
}

export function getAvailableExternals(): string[] {
	return [...Object.keys(eager), ...Object.keys(lazy)];
}

declare global {
	var __mma_require: typeof mmaRequire;
}

globalThis.__mma_require = mmaRequire;
