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

/* eslint-disable no-console */
/** A log sink with no Tauri host behind it has to fail silently -- routing the
 *  rejection anywhere would re-enter `log` and recurse. */
const sink = (p: Promise<unknown>) => void p.catch(() => {});

export const log = {
	info: (msg: string, ...args: unknown[]) => {
		if (DEV) console.info(msg, ...args);
		sink(tauriInfo(fmt(msg, ...args)));
	},
	warn: (msg: string, ...args: unknown[]) => {
		if (DEV) console.warn(msg, ...args);
		sink(tauriWarn(fmt(msg, ...args)));
	},
	error: (msg: string, ...args: unknown[]) => {
		if (DEV) console.error(msg, ...args);
		sink(tauriError(fmt(msg, ...args)));
	},
	debug: (msg: string, ...args: unknown[]) => {
		if (DEV) console.debug(msg, ...args);
		sink(tauriDebug(fmt(msg, ...args)));
	},
	trace: (msg: string, ...args: unknown[]) => {
		if (DEV) console.debug(msg, ...args);
		sink(tauriTrace(fmt(msg, ...args)));
	},
};
/* eslint-enable no-console */

export async function initLogging() {
	window.addEventListener("error", (e) => {
		log.error("[uncaught]", e.error ?? e.message);
	});

	window.addEventListener("unhandledrejection", (e) => {
		log.error("[unhandled rejection]", e.reason);
	});

	log.info("Frontend logging initialized");
}
