import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";

const pending: Array<() => void> = [];

afterEach(() => {
	for (const unmount of pending.splice(0)) unmount();
});

export interface Mounted {
	container: HTMLDivElement;
	root: Root;
	unmount: () => void;
}

/** Render into a fresh root, torn down after the test. `attach: false` keeps the
 *  container out of the document, for probes that only read the hook's return. */
export function mount(node: ReactNode, opts: { attach?: boolean } = {}): Mounted {
	const container = document.createElement("div");
	if (opts.attach !== false) document.body.appendChild(container);
	const root = createRoot(container);
	let done = false;
	const unmount = () => {
		if (done) return;
		done = true;
		act(() => root.unmount());
		container.remove();
	};
	pending.push(unmount);
	act(() => root.render(node));
	return { container, root, unmount };
}

/** `mount` plus one flushed microtask, for trees whose effects resolve a promise. */
export async function mountAsync(node: ReactNode, opts: { attach?: boolean } = {}) {
	const mounted = mount(node, opts);
	await act(async () => {});
	return mounted;
}
