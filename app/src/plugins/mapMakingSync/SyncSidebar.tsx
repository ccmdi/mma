import { useCallback, useEffect, useState } from "react";
import { Field } from "@/components/primitives/Sidebar";
import { mapMakingApp } from "@/components/primitives/Icon";
import { ConnectionUser, SyncSidebar as SharedSyncSidebar } from "@/lib/sync/ui/SyncSidebar";
import type { Remote } from "./map-making-web-api";
import * as auth from "./controller";
import { controller } from "./controller";

/** The shared sync sidebar, with map-making.app's API-key auth plugged into it. */
export function SyncSidebar({ onClose }: { onClose: () => void }) {
	const [keyDraft, setKeyDraft] = useState(auth.getApiKey());
	const [user, setUser] = useState<Remote.User | null>(auth.getCachedUser());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// True only while the mount-time validation below is in flight. With no key there is nothing
	// to check, so the key form shows immediately rather than flashing through a "checking" state.
	const [checking, setChecking] = useState(() => !!auth.getApiKey() && !auth.getCachedUser());

	const validate = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			// Validate before persisting: a typo'd key must not replace a working one.
			const user = await auth.validate(keyDraft);
			auth.setApiKey(keyDraft);
			setUser(user);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setUser(null);
		} finally {
			setBusy(false);
			setChecking(false);
		}
	}, [keyDraft]);

	// Validate once when a key exists but nothing is cached yet; cached opens are instant.
	useEffect(() => {
		if (auth.getApiKey() && !auth.getCachedUser()) void validate();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const authUi = user ? (
		// map-making.app's API-key surface exposes no avatar (auth is Discord-side), so the
		// initial-letter fallback is permanent here.
		<ConnectionUser
			name={user.username}
			action={
				<button
					className="button"
					onClick={() => {
						auth.forgetAuth();
						setUser(null);
					}}
				>
					Change key
				</button>
			}
		/>
	) : (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void validate();
			}}
		>
			{/* Hidden username satisfies the password-form a11y heuristic. */}
			<input
				type="text"
				autoComplete="username"
				defaultValue="map-making.app"
				tabIndex={-1}
				aria-hidden
				style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
			/>
			<Field label="API key" hint="Get one at map-making.app/keys">
				<input
					className="input"
					type="password"
					autoComplete="current-password"
					value={keyDraft}
					onChange={(e) => setKeyDraft(e.target.value)}
					placeholder="paste API key"
				/>
			</Field>
			<button className="button button--primary" type="submit" disabled={busy || !keyDraft}>
				{busy ? "Validating..." : "Validate"}
			</button>
			{error && (
				<p className="mma-input__help" style={{ color: "var(--red-9, #e5484d)" }}>
					{error}
				</p>
			)}
		</form>
	);

	return (
		<SharedSyncSidebar
			onClose={onClose}
			controller={controller}
			auth={authUi}
			identity={checking ? undefined : user ? { id: String(user.id) } : null}
			listMaps={auth.listMaps}
			brand={{ path: mapMakingApp, color: "#CC2F2D" }}
		/>
	);
}
