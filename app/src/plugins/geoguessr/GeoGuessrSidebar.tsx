import { useCallback, useEffect, useState } from "react";
import { Field } from "@/components/primitives/Sidebar";
import { SyncSidebar } from "@/lib/sync/ui/SyncSidebar";
import { log } from "@/lib/util/log";
import { controller, geoguessrProvider } from "./provider";

interface GgIdentity {
	id: string;
	nick: string;
}

/**
 * GeoGuessr has no API keys. Signing in opens the real geoguessr.com login in its own window and
 * Rust reads the session cookie back out, so email, Google, Facebook, 2FA and captcha all work
 * without us ever handling a password.
 */
export function GeoGuessrSidebar({ onClose }: { onClose: () => void }) {
	// `undefined` until the first session check resolves, so the sidebar can say "checking"
	// instead of flashing the signed-out UI.
	const [user, setUser] = useState<GgIdentity | null | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			setUser(await window.MMA.cmd.geoguessrMe());
		} catch (e) {
			log.warn("geoguessr: session check failed", e);
			setUser(null);
		}
	}, []);

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
		setUser(null);
	}, []);

	const auth = user ? (
		<Field label="Signed in" row>
			<span>
				{user.nick}{" "}
				<button className="button" onClick={() => void signOut()}>
					Sign out
				</button>
			</span>
		</Field>
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
		/>
	);
}
