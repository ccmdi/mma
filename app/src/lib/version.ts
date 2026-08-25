declare const __APP_VERSION__: string;

/** The Vite-injected app version, or null where the define is absent (tests, bare vite serve). */
export function appVersion(): string | null {
	return typeof __APP_VERSION__ === "undefined" ? null : __APP_VERSION__;
}
