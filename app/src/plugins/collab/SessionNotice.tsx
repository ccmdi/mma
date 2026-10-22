import { useEffect } from "react";
import { cmd } from "@/lib/commands";
import { useJob } from "@/lib/hooks/useJob";
import { errText } from "@/lib/util/format";
import { t } from "@/lib/i18n";
import { Maps } from "@/store/maps";
import { Dialog, DialogActions, DialogContent } from "@/components/primitives/Dialog";
import { Notice } from "@/components/primitives/Hint";
import { Sessions } from "./sessions";

/** Follows this app's collab sessions while mounted, and asks the user what they have yet to
 *  answer: a session they did not leave ended, or joining would replace edits to their copy. */
export function SessionNotice() {
	useEffect(() => Sessions.follow(), []);
	const asking = Sessions.use().asking();
	const maps = Maps.useList();
	const action = useJob();
	if (!asking) return null;

	const { map, session, origin, notice } = asking;
	const name = maps.find((m) => m.id === map)?.name || t("(unnamed)");
	const busy = action.status === "loading";
	const run = (work: () => Promise<unknown>) => () => void action.run(work);
	const failed = action.status === "error" && <Notice tone="error">{errText(action.error)}</Notice>;
	const ask = (title: string, message: string, actions: Parameters<typeof DialogActions>[0]) => (
		<Dialog open onOpenChange={(o) => !o && Sessions.settle(map)}>
			<DialogContent title={title} size="sm">
				<div className="modal__stack">
					<p className="modal__message">{message}</p>
					{failed}
					<DialogActions {...actions} />
				</div>
			</DialogContent>
		</Dialog>
	);

	if (notice.ask === "replace")
		return ask(
			t("Your copy has changes"),
			t('Your copy of "{name}" was edited since you last joined. Joining replaces those edits.', {
				name,
			}),
			{
				destructive: {
					label: t("Replace my edits"),
					disabled: busy,
					onClick: run(() => Sessions.replace(map)),
				},
				cancel: { disabled: busy },
				primary: {
					label: t("Keep a copy and join"),
					disabled: busy,
					onClick: run(async () => {
						await Maps.duplicate(map, Maps.copyName(name));
						await Sessions.replace(map);
					}),
				},
			},
		);

	if (session?.link.state !== "ended") return null;
	const params = { name, reason: session.link.reason };
	const rejoin = session.hosting
		? { label: t("Host again"), onClick: run(() => cmd.collabHost(map)) }
		: origin
			? { label: t("Rejoin"), onClick: run(() => Sessions.join(origin.via)) }
			: undefined;
	return ask(
		session.hosting
			? t("Hosting stopped")
			: t("Disconnected from {host}'s map", { host: session.host }),
		session.hosting
			? t('The session on "{name}" ended: {reason}.', params)
			: t('The session on "{name}" ended: {reason}. Your copy stays in your map list.', params),
		{
			cancel: {
				label: session.hosting ? t("Dismiss") : t("Keep my copy"),
				disabled: busy,
				onClick: run(() => Sessions.leave(map)),
			},
			primary: rejoin && { ...rejoin, disabled: busy },
		},
	);
}
