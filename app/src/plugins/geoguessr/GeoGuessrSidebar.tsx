import { useCallback, useEffect, useState } from "react";
import { mdiMapMarker } from "@mdi/js";
import { ConnectionUser, SyncSidebar } from "@/lib/sync/ui/SyncSidebar";
import { log } from "@/lib/util/log";
import { controller, geoguessrProvider, PLUGIN_ID } from "./provider";

const CACHED_USER = "user";
const kv = () => window.MMA.storage(PLUGIN_ID);

interface GgIdentity {
	id: string;
	nick: string;
	/** Avatar pin path (`pin/<hash>.png`); absent on older cached entries. */
	pin?: string | null;
}

/**
 * GeoGuessr has no API keys. Signing in opens the real geoguessr.com login in its own window and
 * Rust reads the session cookie back out, so email, Google, Facebook, 2FA and captcha all work
 * without us ever handling a password.
 */
export function GeoGuessrSidebar({ onClose }: { onClose: () => void }) {
	// Last known identity, so reopening the sidebar paints the signed-in state immediately instead
	// of spinning through a round trip every time. `undefined` only on the very first open, when
	// there is genuinely nothing to show yet. The cache is corrected by the check below.
	const [user, setUser] = useState<GgIdentity | null | undefined>(() =>
		kv().get<GgIdentity | null | undefined>(CACHED_USER, undefined),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const remember = useCallback((next: GgIdentity | null) => {
		kv().set(CACHED_USER, next);
		setUser(next);
	}, []);

	const refresh = useCallback(async () => {
		try {
			remember(await window.MMA.cmd.geoguessrMe());
		} catch (e) {
			// A failed check says nothing about the session (offline, transient). Keep what we had
			// rather than falsely reporting a sign-out.
			log.warn("geoguessr: session check failed", e);
		}
	}, [remember]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const signIn = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			await window.MMA.cmd.geoguessrLogin();
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [refresh]);

	const signOut = useCallback(async () => {
		await window.MMA.cmd.geoguessrLogout();
		remember(null);
	}, [remember]);

	const auth = user ? (
		<ConnectionUser
			name={user.nick}
			avatarUrl={
				user.pin
					? `https://www.geoguessr.com/images/resize:auto:96:96/gravity:ce/plain/${user.pin}`
					: null
			}
			action={
				<button className="button" onClick={() => void signOut()}>
					Sign out
				</button>
			}
		/>
	) : (
		<>
			<button className="button button--primary" disabled={busy} onClick={() => void signIn()}>
				{busy ? "Waiting for sign-in..." : "Sign in to GeoGuessr"}
			</button>
			{error && (
				<p className="mma-input__help" style={{ color: "var(--red-9, #e5484d)" }}>
					{error}
				</p>
			)}
		</>
	);

	return (
		<SyncSidebar
			onClose={onClose}
			controller={controller}
			auth={auth}
			identity={user === undefined ? undefined : user ? { id: user.id } : null}
			listMaps={() => geoguessrProvider.listMaps()}
			brand={{ path: mdiMapMarker, color: "#CC302E" }}
		/>
	);
}
