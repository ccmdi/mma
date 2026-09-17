// React's act() only runs its queue when this is set, and every React spec needs it.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// jsdom has no layout, so every modal's size observer and motion query need an inert stand-in.
if (typeof window !== "undefined") {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	window.matchMedia ??= (query: string) =>
		({
			matches: false,
			media: query,
			onchange: null,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
			dispatchEvent: () => false,
		}) as MediaQueryList;
}
