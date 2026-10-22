import type { SessionLink } from "@/bindings.gen";
import { msg, t } from "@/lib/i18n";
import { openDialog } from "@/store/dialogBus";
import { Store } from "@/store/store";
import { Pill, type PillTone } from "@/components/primitives/Pill";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Avatar } from "@/components/primitives/Avatar";
import { rgbCss } from "@/lib/util/color";
import { Sessions, type Session } from "./sessions";
import "./collab.css";

const STATE: Record<SessionLink["state"], { label: string; tone: PillTone }> = {
	waiting: { label: msg("waiting"), tone: "warning" },
	connecting: { label: msg("connecting"), tone: "warning" },
	syncing: { label: msg("receiving"), tone: "warning" },
	live: { label: msg("live"), tone: "accent" },
	reconnecting: { label: msg("reconnecting"), tone: "warning" },
	ended: { label: msg("ended"), tone: "neutral" },
};

/** This app's role in `session` and the state of its link, why it ended on hover. */
export function SessionPill({ session }: { session: Session }) {
	const { link } = session;
	const role = session.hosting
		? t("Hosting")
		: session.people.find((p) => p.login === session.you)?.guest
			? t("Guest of {host}", { host: session.host })
			: t("Following {host}", { host: session.host });
	const pill = (
		<Pill tone={STATE[link.state].tone}>
			{role} · {t(STATE[link.state].label)}
		</Pill>
	);
	return link.state === "ended" ? <Tooltip content={link.reason}>{pill}</Tooltip> : pill;
}

const FACES = 5;

/** The open map's place in a collab session, or where its copy came from, opening the collab dialog. */
export function CollabHeader() {
	const openMap = Store.use((s) => s.mapId);
	const sessions = Sessions.use();
	const session = sessions.on(openMap);
	const origin = sessions.origin(openMap);
	const open = () => openDialog("plugin-modal", "collab");

	if (session && !session.ended) {
		return (
			<span className="collab-status">
				<button type="button" className="collab-status__open" onClick={open}>
					<SessionPill session={session} />
				</button>
				<span className="collab-status__faces">
					{session.people.slice(0, FACES).map((person) => (
						<Tooltip key={person.login} content={person.name} side="bottom">
							<Avatar src={person.avatar} size={18} ring={rgbCss(person.color)} />
						</Tooltip>
					))}
					{session.people.length > FACES && (
						<span className="collab__meta">+{session.people.length - FACES}</span>
					)}
				</span>
			</span>
		);
	}
	if (origin)
		return (
			<button type="button" className="collab-status collab-status__open" onClick={open}>
				<Pill>{t("Copy of {host}'s map", { host: origin.host })}</Pill>
			</button>
		);
	return null;
}
