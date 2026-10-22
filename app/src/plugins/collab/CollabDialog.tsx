import { useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
	mdiClose,
	mdiContentCopy,
	mdiCloseCircleOutline,
	mdiCrown,
	mdiTicketOutline,
} from "@mdi/js";
import type { DeviceCodeInfo, Share, Shares } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { useEventValue } from "@/lib/events";
import { Account } from "@/lib/account";
import { useJob } from "@/lib/hooks/useJob";
import { persisted, useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { search } from "@/lib/search";
import { openWindow } from "@/lib/window";
import { holds } from "@/lib/util/holds";
import { latest } from "@/lib/util/latest";
import { toast } from "@/lib/util/toast";
import { errText } from "@/lib/util/format";
import { log } from "@/lib/util/log";
import { msg, t } from "@/lib/i18n";
import { Maps } from "@/store/maps";
import { Store } from "@/store/store";
import { definePluginEvent, emitPluginEvent } from "@/plugins/scope";
import { Loading, type AsyncState, type Result, type Settled } from "@/types/util";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { Icon } from "@/components/primitives/Icon";
import { IconButton } from "@/components/primitives/IconButton";
import { TextInput } from "@/components/primitives/TextInput";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { Notice } from "@/components/primitives/Hint";
import { Pill } from "@/components/primitives/Pill";
import { Spinner } from "@/components/primitives/Spinner";
import { Tooltip } from "@/components/primitives/Tooltip";
import { SegmentedControl } from "@/components/primitives/Sidebar";
import { SwitchRow } from "@/components/primitives/SwitchRow";
import { Avatar } from "@/components/primitives/Avatar";
import { rgbCss } from "@/lib/util/color";
import { toPeople, type Person } from "./people";
import { Presence } from "./presence";
import { Sessions } from "./sessions";
import { SessionPill } from "./CollabHeader";
import "./collab.css";

function Chip({
	person,
	here,
	host,
	you,
	onRemove,
}: {
	person: Person;
	here?: boolean;
	host?: boolean;
	you?: boolean;
	onRemove?: () => void;
}) {
	const { name } = person;
	return (
		<li className={clsx("collab__chip", here && "collab__chip--here")}>
			<Tooltip content={here ? t("{login} is here now", { login: name }) : name}>
				<Avatar src={person.avatar} size={18} ring={here ? rgbCss(person.color) : undefined} />
			</Tooltip>
			<span>{name}</span>
			{host && (
				<Tooltip content={t("Host")}>
					<span className="collab__crown" role="img" aria-label={t("Host")}>
						<Icon path={mdiCrown} size={12} />
					</span>
				</Tooltip>
			)}
			{you && <Pill tone="accent">{t("You")}</Pill>}
			{onRemove && (
				<IconButton
					className="icon-button--inline"
					icon={mdiClose}
					size={14}
					label={t("Remove {login}", { login: name })}
					onClick={onRemove}
				/>
			)}
		</li>
	);
}

const SHOWS = [
	{ key: "cursors" as const, label: msg("Show cursors") },
	{ key: "viewports" as const, label: msg("Show viewports") },
	{ key: "pings" as const, label: msg("Show clicks") },
];

/** A text field and its button, handing over the trimmed text and clearing once that succeeds. */
function Submit({
	placeholder,
	label,
	tooltip,
	busy,
	onSubmit,
}: {
	placeholder: string;
	label: string;
	tooltip?: string;
	busy: boolean;
	onSubmit: (text: string) => Promise<Settled<unknown>>;
}) {
	const [text, setText] = useState("");
	const submit = () => {
		const trimmed = text.trim();
		if (trimmed && !busy) void onSubmit(trimmed).then((r) => r.status === "ok" && setText(""));
	};
	const button = (
		<Button disabled={busy || !text.trim()} onClick={submit}>
			{label}
		</Button>
	);
	return (
		<div className="collab__add">
			<TextInput
				value={text}
				placeholder={placeholder}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => e.key === "Enter" && submit()}
			/>
			{tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button}
		</div>
	);
}

/** Run `work` on the dialog's job, then check the user's shares again. */
type Change = (work: () => Promise<unknown>) => Promise<Settled<unknown>>;

function ShareAnother({ mine, busy, change }: { mine: Share[]; busy: boolean; change: Change }) {
	const maps = Maps.useList();
	const sessions = Sessions.use();
	const [query, setQuery] = useState("");
	const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
	const q = query.trim();
	const suggestions = useMemo(
		() =>
			q && !picked
				? search(
						maps.filter(
							(m) =>
								!Maps.isReserved(m.id) &&
								!sessions.origin(m.id) &&
								!mine.some((s) => s.map === m.id),
						),
						q,
						(m) => [m.name],
					).slice(0, 8)
				: [],
		[maps, sessions, mine, q, picked],
	);
	return (
		<div className="collab__share">
			<SuggestInput
				placeholder={t("Share a map...")}
				value={query}
				onChange={(v) => {
					setQuery(v);
					setPicked(null);
				}}
				suggestions={suggestions}
				getKey={(m) => m.id}
				onPick={(m) => {
					setQuery(m.name || t("(unnamed)"));
					setPicked({ id: m.id, name: m.name });
				}}
				portal
				renderItem={(m) => (
					<>
						<strong>{m.name || t("(unnamed)")}</strong>
						{m.folder && <span className="search-result__context truncate"> · {m.folder}</span>}
					</>
				)}
			/>
			{picked && (
				<Submit
					placeholder={t("GitHub username")}
					label={t("Share")}
					busy={busy}
					onSubmit={(login) =>
						change(async () => {
							await cmd.collabShare(picked.id, [login]);
							setPicked(null);
							setQuery("");
						})
					}
				/>
			)}
		</div>
	);
}

const SHARES = definePluginEvent("collab", "shares");
const SHARES_POLL_MS = 30_000;

let shares: { login: string; state: Result<Shares> } | null = null;
const checks = latest<Shares>();
let poll: ReturnType<typeof setInterval> | undefined;

/** Check the signed-in user's shares again. */
async function checkShares(): Promise<void> {
	const login = (await Account.me())?.login;
	if (!login) return;
	const state = await checks.replace(() => cmd.collabShares());
	if (state.status === "cancelled") return;
	shares = { login, state };
	emitPluginEvent(SHARES);
}

const watching = holds(() => {
	if (watching.held() && poll === undefined) {
		void checkShares();
		poll = setInterval(() => !document.hidden && void checkShares(), SHARES_POLL_MS);
	}
	if (!watching.held() && poll !== undefined) {
		clearInterval(poll);
		poll = undefined;
	}
});

/** React hook: the signed-in user's shares, checked every half minute while anything shows them. */
function useShares(): AsyncState<Shares> {
	const login = Account.use()?.login;
	useEffect(() => (login ? watching.hold() : undefined), [login]);
	const current = useEventValue(SHARES, () => shares);
	if (!current || current.login !== login) return new Loading();
	return current.state;
}

type Tab = "join" | "share";
const TAB = persisted<Tab | null>("collabTab", null);

const TABS = [
	{ value: "join" as const, label: msg("Join") },
	{ value: "share" as const, label: msg("Share") },
];

/** Who this user collaborates with, and the sessions they are in. */
export function CollabDialog({ onClose }: { onClose: () => void }) {
	const user = Account.use();
	const shares = useShares();
	const sessions = Sessions.use();
	const maps = Maps.useList();
	const openMap = Store.use((s) => s.mapId);
	const action = useJob();
	const signingIn = useJob<unknown, DeviceCodeInfo>();
	const [chosen, choose] = useLocalStorage(TAB);
	const [shown, show] = useLocalStorage(Presence.shown);
	const busy = action.status === "loading";
	const change: Change = (work) =>
		action.run(async () => {
			await work();
			await checkShares();
		});

	const here = sessions.on(openMap);
	const known = shares.ok();
	const tab = chosen ?? (here?.hosting || known?.mine.length ? "share" : "join");
	const nameOf = (id: string) => maps.find((m) => m.id === id)?.name || t("(unnamed)");
	const code = signingIn.status === "loading" ? signingIn.progress : null;
	const byAccount = (content: (shares: Shares) => ReactNode) =>
		!user ? (
			<div className="collab__section">
				<Button
					variant="primary"
					onClick={() => void signingIn.run(({ report }) => Account.signIn(report))}
				>
					{t("Sign in with GitHub")}
				</Button>
				{code && (
					<p className="text-muted">
						{t("Enter code {code} in your browser to finish signing in.", { code: code.userCode })}
					</p>
				)}
				{signingIn.status === "error" && <Notice tone="error">{errText(signingIn.error)}</Notice>}
			</div>
		) : known ? (
			content(known)
		) : shares.status === "error" ? (
			<Notice tone="error">{errText(shares.error)}</Notice>
		) : (
			<Spinner />
		);

	const body = (
		<div className="collab__body">
			{action.status === "error" && <Notice tone="error">{errText(action.error)}</Notice>}

			{here && (
				<section className="collab__section">
					<h3 className="eyebrow">{t("This map")}</h3>
					<div className="collab__row">
						<ul className="collab__people">
							{here.people.map((person) => (
								<Chip
									key={person.login}
									person={person}
									here
									host={person.login === here.host}
									you={person.login === here.you}
								/>
							))}
						</ul>
						<Button disabled={busy} onClick={() => void action.run(() => Sessions.leave(here.map))}>
							{here.ended ? t("Dismiss") : here.hosting ? t("Stop") : t("Leave")}
						</Button>
					</div>
					{!here.ended && (
						<div className="collab__switches">
							{SHOWS.map(({ key, label }) => (
								<Tooltip key={key} content={t("Only changes what you see")}>
									<span>
										<SwitchRow
											checked={shown[key]}
											onChange={(on) => show({ ...shown, [key]: on })}
											label={t(label)}
										/>
									</span>
								</Tooltip>
							))}
						</div>
					)}
				</section>
			)}

			<SegmentedControl
				role="tabs"
				fill
				options={TABS.map((o) => ({ value: o.value, label: t(o.label) }))}
				value={tab}
				onChange={choose}
			/>

			{tab === "join" ? (
				<>
					<section className="collab__section">
						<h3 className="eyebrow">{t("Shared with your account")}</h3>
						{byAccount(({ withMe }) =>
							withMe.length === 0 ? (
								<p className="text-muted">{t("Nothing shared with you yet.")}</p>
							) : (
								<ul className="collab__list">
									{withMe.map((shared) => {
										const copy = maps.find((m) => {
											const origin = sessions.origin(m.id);
											return origin && origin.host === shared.host && origin.map === shared.map;
										});
										const joined = copy && sessions.on(copy.id)?.ended === false;
										return (
											<li key={`${shared.host}/${shared.map}`} className="collab__row">
												<Avatar src={toPeople([{ login: shared.host, guest: false }])[0].avatar} />
												<span className="collab__text">
													<span className="truncate">{shared.name || t("(unnamed)")}</span>
													<span className="collab__meta truncate">
														{shared.host}
														{" · "}
														<span className={clsx(shared.live && "collab__live")}>
															{shared.live ? t("Live") : t("Offline")}
														</span>
													</span>
												</span>
												{joined ? (
													<Button
														onClick={() =>
															void openWindow({ type: "editor", mapId: copy.id }, copy.name)
														}
													>
														{t("Open")}
													</Button>
												) : (
													<Button
														variant="primary"
														disabled={busy}
														onClick={() =>
															void action.run(() =>
																Sessions.join({ host: shared.host, map: shared.map }),
															)
														}
													>
														{t("Join")}
													</Button>
												)}
											</li>
										);
									})}
								</ul>
							),
						)}
					</section>
					<section className="collab__section">
						<h3 className="eyebrow">{t("Join with an invite code")}</h3>
						<Submit
							placeholder={t("Invite code")}
							label={t("Join with code")}
							tooltip={t("Join a map as a guest, with the code its host gave you")}
							busy={busy}
							onSubmit={(invite) => action.run(() => Sessions.join({ code: invite }))}
						/>
					</section>
				</>
			) : (
				byAccount(({ mine }) => (
					<section className="collab__section">
						<h3 className="eyebrow">{t("My shares")}</h3>
						{mine.length > 0 && (
							<ul className="collab__list">
								{mine.map(({ map, logins, invite }) => {
									const session = sessions.on(map);
									const hosted = session?.ended === false ? session : undefined;
									const present = new Map(
										hosted?.people.filter((p) => p.login !== hosted.you).map((p) => [p.login, p]),
									);
									const people = toPeople([
										...logins.map((login) => ({ login, guest: false })),
										...present.values(),
									]);
									const turn = (on: boolean) => void change(() => cmd.collabInvite(map, on));
									return (
										<li key={map} className="collab__share">
											<div className="collab__row">
												<span className="collab__text truncate">{nameOf(map)}</span>
												{hosted && <SessionPill session={hosted} />}
												{invite ? (
													<span className="collab__invite">
														<Tooltip content={t("Guests join with this code")}>
															<code className="collab__code">{invite}</code>
														</Tooltip>
														<IconButton
															className="icon-button--inline"
															icon={mdiContentCopy}
															size={14}
															label={t("Copy the invite code")}
															onClick={() =>
																void navigator.clipboard.writeText(invite).then(
																	() => toast(t("Copied")),
																	(e: unknown) =>
																		log.warn(
																			`[collab] could not copy the invite code: ${errText(e)}`,
																		),
																)
															}
														/>
														<IconButton
															className="icon-button--inline"
															icon={mdiCloseCircleOutline}
															size={14}
															label={t("Turn off the invite and remove its guests")}
															disabled={busy}
															onClick={() => turn(false)}
														/>
													</span>
												) : (
													<IconButton
														icon={mdiTicketOutline}
														size={18}
														label={t("Turn on a guest invite")}
														tooltip={t("Let people without a GitHub account join with a code")}
														disabled={busy}
														onClick={() => turn(true)}
													/>
												)}
												{hosted ? (
													<Button
														disabled={busy}
														onClick={() => void action.run(() => Sessions.leave(map))}
													>
														{t("Stop hosting")}
													</Button>
												) : (
													<Button
														variant="primary"
														disabled={busy}
														onClick={() => void action.run(() => cmd.collabHost(map))}
													>
														{t("Host")}
													</Button>
												)}
											</div>
											<ul className="collab__people">
												{people.map((person) => (
													<Chip
														key={person.login}
														person={present.get(person.login) ?? person}
														here={present.has(person.login)}
														onRemove={
															busy || person.guest
																? undefined
																: () =>
																		void change(() =>
																			cmd.collabShare(
																				map,
																				logins.filter((l) => l !== person.login),
																			),
																		)
														}
													/>
												))}
											</ul>
											<Submit
												placeholder={t("GitHub username")}
												label={t("Add")}
												busy={busy}
												onSubmit={(login) => change(() => cmd.collabShare(map, [...logins, login]))}
											/>
										</li>
									);
								})}
							</ul>
						)}
						<ShareAnother mine={mine} busy={busy} change={change} />
					</section>
				))
			)}
		</div>
	);

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent title={t("Collaboration")} size="md" className="collab">
				{user === undefined ? <Spinner /> : body}
			</DialogContent>
		</Dialog>
	);
}

function SessionDot({ map }: { map: string }) {
	const session = Sessions.use().on(map);
	if (!session) return null;
	return (
		<span
			className={clsx(
				"collab__dot",
				session.ended && "collab__dot--ended",
				!session.live && !session.ended && "collab__dot--pending",
			)}
		/>
	);
}

function LiveDot() {
	const shares = useShares();
	const live = !!shares.ok()?.withMe.some((s) => s.live);
	return live && <span className="collab__dot" />;
}

/** The open map's session state, or on the map list whether a map shared with this user is live. */
export function CollabBadge() {
	const openMap = Store.use((s) => s.mapId);
	return openMap ? <SessionDot map={openMap} /> : <LiveDot />;
}
