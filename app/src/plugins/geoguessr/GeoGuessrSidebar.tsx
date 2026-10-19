import { useJob } from "@/lib/hooks/useJob";
import { useCallback, useEffect, useState } from "react";
import { ConnectionUser, SyncSidebar } from "@/lib/sync/ui/SyncSidebar";
import { log } from "@/lib/util/log";
import { errText } from "@/lib/util/format";
import { controller, createMap, listMaps, PLUGIN_ID } from "./provider";
import { t } from "@/lib/i18n";
import { Button } from "@/components/primitives/Button";
import { Notice } from "@/components/primitives/Hint";

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
	const signingIn = useJob();

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
			action={<Button onClick={() => void signOut()}>{t("Sign out")}</Button>}
		/>
	) : (
		<>
			<Button
				variant="primary"
				disabled={signingIn.status === "loading"}
				onClick={() =>
					void signingIn.run(async () => {
						await window.MMA.cmd.geoguessrLogin();
						await refresh();
					})
				}
			>
				{signingIn.status === "loading" ? t("Waiting for sign-in...") : t("Sign in to GeoGuessr")}
			</Button>
			{signingIn.status === "error" && <Notice tone="error">{errText(signingIn.error)}</Notice>}
		</>
	);

	return (
		<SyncSidebar
			onClose={onClose}
			controller={controller}
			auth={auth}
			identity={user === undefined ? undefined : user ? { id: user.id } : null}
			source={{ kind: "list", listMaps: () => listMaps(), createMap }}
		/>
	);
}
