// The plugin sidecar client: one set of Tauri event listeners for every request,
// demultiplexed by run id. The app owns the processes; this is how the webview
// talks to them.

import { events } from "@/bindings.gen";
import { cmd as commands } from "@/lib/commands";

type SidecarEvent =
	| { kind: "line"; line: string }
	| { kind: "log"; line: string }
	| { kind: "done"; error: string | null };

const sidecarHandlers = new Map<number, (ev: SidecarEvent) => void>();
let sidecarListeners: Promise<void> | null = null;

function listenForSidecarEvents(): Promise<void> {
	sidecarListeners ??= (async () => {
		await events.sidecarLine.listen((ev) =>
			sidecarHandlers.get(ev.payload.runId)?.({ kind: "line", line: ev.payload.line }),
		);
		await events.sidecarLog.listen((ev) =>
			sidecarHandlers.get(ev.payload.runId)?.({ kind: "log", line: ev.payload.line }),
		);
		await events.sidecarDone.listen((ev) =>
			sidecarHandlers.get(ev.payload.runId)?.({ kind: "done", error: ev.payload.error }),
		);
	})();
	return sidecarListeners;
}

export interface SidecarOptions<T> {
	/** Fires once per JSON object the sidecar emits, in order. */
	onLine?(item: T): void;
	/** Sidecar diagnostic output, one-shot runs only. */
	onLog?(line: string): void;
	signal?: AbortSignal;
}

/** Send a command to a plugin's sidecar and resolve with its last emitted JSON
 *  object (null if it emitted none). `payload` is sent as JSON. */
async function request<T>(
	pluginId: string,
	command: string,
	payload?: unknown,
	opts?: SidecarOptions<T>,
): Promise<T | null> {
	const aborted = () => new DOMException(`Sidecar ${command} aborted`, "AbortError");
	if (opts?.signal?.aborted) throw aborted();
	await listenForSidecarEvents();
	const runId = await commands.runReserve();

	return new Promise<T | null>((resolve, reject) => {
		if (opts?.signal?.aborted) {
			reject(aborted());
			return;
		}
		let last: T | null = null;
		// Abort kills the run but leaves the handler installed, so the `done` that
		// follows still cleans up. Resident-served work has no process to kill.
		const onAbort = () => {
			commands.runCancel(runId).catch(() => {});
			reject(aborted());
		};
		sidecarHandlers.set(runId, (ev) => {
			if (ev.kind === "line") {
				let item: T;
				try {
					item = JSON.parse(ev.line) as T;
				} catch {
					return;
				}
				last = item;
				opts?.onLine?.(item);
			} else if (ev.kind === "log") {
				opts?.onLog?.(ev.line);
			} else {
				sidecarHandlers.delete(runId);
				opts?.signal?.removeEventListener("abort", onAbort);
				if (ev.error) reject(new Error(ev.error));
				else resolve(last);
			}
		});
		opts?.signal?.addEventListener("abort", onAbort);

		commands
			.sidecarRequest(
				pluginId,
				command,
				payload === undefined ? null : JSON.stringify(payload),
				runId,
			)
			.catch((e: unknown) => {
				sidecarHandlers.delete(runId);
				opts?.signal?.removeEventListener("abort", onAbort);
				reject(e);
			});
	});
}

/** The sidecar version installed for a plugin, or null when it has none yet. */
function installedVersion(pluginId: string): Promise<string | null> {
	return commands.sidecarInstalledVersion(pluginId);
}

/** The nested `sidecar` namespace on the plugin surface. */
export const sidecar = { request, installedVersion };
