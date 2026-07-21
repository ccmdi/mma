import { useCallback, useEffect, useState } from "react";
import { Field } from "@/components/primitives/Sidebar";
import { SyncSidebar as SharedSyncSidebar } from "@/lib/sync/ui/SyncSidebar";
import type { Remote } from "./map-making-web-api";
import * as auth from "./controller";
import { controller } from "./controller";

/** The shared sync sidebar, with map-making.app's API-key auth plugged into it. */
export function SyncSidebar({ onClose }: { onClose: () => void }) {
	const [keyDraft, setKeyDraft] = useState(auth.getApiKey());
	const [user, setUser] = useState<Remote.User | null>(auth.getCachedUser());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const validate = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			auth.setApiKey(keyDraft);
			setUser(await auth.validate());
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setUser(null);
		} finally {
			setBusy(false);
		}
	}, [keyDraft]);

	// Validate once when a key exists but nothing is cached yet; cached opens are instant.
	useEffect(() => {
		if (auth.getApiKey() && !auth.getCachedUser()) void validate();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const authUi = user ? (
		<Field label="Signed in" row>
			<span>
				{user.username}{" "}
				<button
					className="button"
					onClick={() => {
						auth.forgetAuth();
						setUser(null);
					}}
				>
					Change key
				</button>
			</span>
		</Field>
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
			identity={user ? { id: String(user.id) } : null}
			listMaps={auth.listMaps}
		/>
	);
}
