import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { errText } from "@/lib/util/util";

/** A call routed in from the local REST transport (see src-tauri/remote_api.rs). */
interface RemoteCall {
	id: number;
	path: string;
	args: unknown[];
}

/** Resolve a dotted path on window.MMA and execute it: functions are applied
 *  with `args` (bound to their parent object), plain values are returned as-is. */
export async function executeMmaPath(path: string, args: unknown[]): Promise<unknown> {
	const segments = path.split(".");
	let parent: unknown = null;
	let target: unknown = window.MMA;
	for (const seg of segments) {
		if (!seg || typeof target !== "object" || target === null || !(seg in target)) {
			throw new Error(`Unknown MMA path: ${path}`);
		}
		parent = target;
		target = (target as Record<string, unknown>)[seg];
	}
	if (typeof target === "function") {
		return await Reflect.apply(target, parent, args);
	}
	if (args.length > 0) throw new Error(`MMA.${path} is not a function`);
	return target;
}

/** Serialize a result to JSON text (the IPC payload is a string -- see
 *  remote_api.rs). Functions, components, Maps etc. fail loudly here. */
function toJson(value: unknown): string {
	if (value === undefined) return "null";
	const s = JSON.stringify(value);
	if (s === undefined) throw new Error("result is not JSON-serializable");
	return s;
}

async function handleRemoteCall({ id, path, args }: RemoteCall): Promise<void> {
	try {
		const result = await executeMmaPath(path, args ?? []);
		await cmd.remoteApiRespond(id, true, toJson(result));
	} catch (e) {
		const msg = errText(e);
		log.warn(`[remote-api] ${path} failed: ${msg}`);
		await cmd.remoteApiRespond(id, false, JSON.stringify(msg));
	}
}

/** Listen for remote API calls targeted at this window. Installed once at startup.
 *  Window-scoped listen: a global `listen` receives `emit_to` events in every window,
 *  so all windows would execute the call and race to respond. */
export function initRemoteHost(): void {
	void getCurrentWebviewWindow().listen<RemoteCall>("mma-remote:call", (ev) => {
		void handleRemoteCall(ev.payload);
	});
}
