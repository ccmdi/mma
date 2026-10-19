import { useState } from "react";
import { useAsync } from "@/lib/hooks/useAsync";
import { useJob } from "@/lib/hooks/useJob";
import { Field } from "@/components/primitives/Sidebar";
import { TextInput } from "@/components/primitives/TextInput";
import { ConnectionUser, SyncSidebar as SharedSyncSidebar } from "@/lib/sync/ui/SyncSidebar";
import * as auth from "./controller";
import { controller } from "./controller";
import { errText } from "@/lib/util/format";
import { t } from "@/lib/i18n";
import { Button } from "@/components/primitives/Button";
import { Notice } from "@/components/primitives/Hint";

/** The shared sync sidebar, with map-making.app's API-key auth plugged into it. */
export function SyncSidebar({ onClose }: { onClose: () => void }) {
	const [keyDraft, setKeyDraft] = useState("");
	const identity = useAsync(() => auth.getCachedUser() ?? (auth.hasKey() ? auth.me() : null), []);
	const [changingKey, setChangingKey] = useState(false);
	const user = changingKey ? null : identity.ok();
	const validating = useJob();

	const validate = () =>
		validating.run(async () => {
			try {
				// Validate before persisting: a typo'd key must not replace a working one.
				await auth.validate(keyDraft);
				await auth.setKey(keyDraft);
			} catch (e) {
				// Validate may have cached the identity before the store failed; a failed
				// submit must leave nothing signed in.
				auth.forgetAuth();
				throw e;
			}
			setChangingKey(false);
			await identity.rerun();
		});
	const failure =
		validating.status === "error"
			? validating.error
			: validating.status === "idle" && identity.status === "error"
				? identity.error
				: null;

	const authUi = user ? (
		// map-making.app's API-key surface exposes no avatar (auth is Discord-side), so the
		// initial-letter fallback is permanent here.
		<ConnectionUser
			name={user.username}
			action={
				<Button
					onClick={() => {
						auth.forgetAuth();
						setChangingKey(true);
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
			<Button
				variant="primary"
				type="submit"
				disabled={validating.status === "loading" || !keyDraft}
			>
				{validating.status === "loading" ? t("Validating...") : t("Validate")}
			</Button>
			{failure && <Notice tone="error">{errText(failure)}</Notice>}
		</form>
	);

	return (
		<SharedSyncSidebar
			onClose={onClose}
			controller={controller}
			auth={authUi}
			identity={identity.status === "loading" ? undefined : user ? { id: String(user.id) } : null}
			source={{ kind: "list", listMaps: auth.listMaps, createMap: auth.createMap }}
		/>
	);
}
