import {
	info as tauriInfo,
	warn as tauriWarn,
	error as tauriError,
	debug as tauriDebug,
	trace as tauriTrace,
} from "@tauri-apps/plugin-log";

function fmt(msg: string, ...args: unknown[]): string {
	if (args.length === 0) return msg;
	return (
		msg +
		" " +
		args
			.map((a) => {
				if (a instanceof Error) return `${a.message}\n${a.stack}`;
				if (typeof a === "object")
					try {
						return JSON.stringify(a);
					} catch {
						return String(a);
					}
				return String(a);
			})
			.join(" ")
	);
}

const DEV = import.meta.env.DEV;
// no webview bridge under vitest/node; console still receives everything
const SHIP = typeof window !== "undefined";

/* eslint-disable no-console */
export const log = {
	info: (msg: string, ...args: unknown[]) => {
		if (DEV) console.info(msg, ...args);
		if (SHIP) tauriInfo(fmt(msg, ...args));
	},
	warn: (msg: string, ...args: unknown[]) => {
		if (DEV) console.warn(msg, ...args);
		if (SHIP) tauriWarn(fmt(msg, ...args));
	},
	error: (msg: string, ...args: unknown[]) => {
		if (DEV) console.error(msg, ...args);
		if (SHIP) tauriError(fmt(msg, ...args));
	},
	debug: (msg: string, ...args: unknown[]) => {
		if (DEV) console.debug(msg, ...args);
		if (SHIP) tauriDebug(fmt(msg, ...args));
	},
	trace: (msg: string, ...args: unknown[]) => {
		if (DEV) console.debug(msg, ...args);
		if (SHIP) tauriTrace(fmt(msg, ...args));
	},
};
/* eslint-enable no-console */

/** Run a promise fire-and-forget, logging any rejection under `label` */
export function fireAndForget(p: Promise<unknown>, label: string): void {
	p.catch((e) => log.error(`[${label}] failed:`, e));
}

export async function initLogging() {
	window.addEventListener("error", (e) => {
		log.error("[uncaught]", e.error ?? e.message);
	});

	window.addEventListener("unhandledrejection", (e) => {
		log.error("[unhandled rejection]", e.reason);
	});

	log.info("Frontend logging initialized");
}
