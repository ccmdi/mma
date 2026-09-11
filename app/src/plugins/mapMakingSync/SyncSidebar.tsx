import { useCallback, useEffect, useState } from "react";
import { Field } from "@/components/primitives/Sidebar";
import { TextInput } from "@/components/primitives/TextInput";
import { mapMakingApp } from "@/components/primitives/Icon";
import { ConnectionUser, SyncSidebar as SharedSyncSidebar } from "@/lib/sync/ui/SyncSidebar";
import type { MmUser } from "@/bindings.gen";
import * as auth from "./controller";
import { controller } from "./controller";
import { errText } from "@/lib/util/format";
import { t } from "@/lib/i18n";
import { Button } from "@/components/primitives/Button";

/** The shared sync sidebar, with map-making.app's API-key auth plugged into it. */
export function SyncSidebar({ onClose }: { onClose: () => void }) {
	const [keyDraft, setKeyDraft] = useState("");
	const [user, setUser] = useState<MmUser | null>(auth.getCachedUser());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// True only while the mount-time check below is in flight. With no key there is nothing to
	// check, so the key form shows immediately rather than flashing through a "checking" state.
	const [checking, setChecking] = useState(() => auth.hasKey() && !auth.getCachedUser());

	const validate = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			// Validate before persisting: a typo'd key must not replace a working one.
			const user = await auth.validate(keyDraft);
			await auth.setKey(keyDraft);
			setUser(user);
		} catch (e) {
			setError(errText(e));
			setUser(null);
		} finally {
			setBusy(false);
		}
	}, [keyDraft]);

	// Check the stored key once when nothing is cached yet; cached opens are instant.
	useEffect(() => {
		if (!auth.hasKey() || auth.getCachedUser()) return;
		auth
			.me()
			.then(setUser)
			.catch((e: unknown) => setError(errText(e)))
			.finally(() => setChecking(false));
	}, []);

	const authUi = user ? (
		// map-making.app's API-key surface exposes no avatar (auth is Discord-side), so the
		// initial-letter fallback is permanent here.
		<ConnectionUser
			name={user.username}
			action={
				<Button
					onClick={() => {
						auth.forgetAuth();
						setUser(null);
					}}
				>
					{t("Change key")}
				</Button>
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
			<Field label={t("API key")} hint={t("Get one at map-making.app/keys")}>
				<TextInput
					type="password"
					autoComplete="current-password"
					value={keyDraft}
					onChange={(e) => setKeyDraft(e.target.value)}
					placeholder={t("paste API key")}
				/>
			</Field>
			<Button variant="primary" type="submit" disabled={busy || !keyDraft}>
				{busy ? t("Validating...") : t("Validate")}
			</Button>
			{error && <p style={{ color: "var(--red-9, #e5484d)" }}>{error}</p>}
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
