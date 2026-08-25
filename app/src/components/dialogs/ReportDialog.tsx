import { useEffect, useMemo, useRef, useState } from "react";
import { mdiClose, mdiGithub, mdiImagePlus, mdiOpenInNew } from "@mdi/js";
import { Button } from "@/components/primitives/Button";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import { Radio } from "@/components/primitives/Radio";
import { TextInput } from "@/components/primitives/TextInput";
import { cmd } from "@/lib/commands";
import {
	buildIssueBody,
	type Attachments,
	type ReportInput,
	type ReportKind,
} from "@/lib/feedback/body";
import {
	MAX_ATTACHMENTS,
	stageImage,
	uploadImages,
	type StagedImage,
} from "@/lib/feedback/attachments";
import { collectDiagnostics, type Diagnostics } from "@/lib/diagnostics";
import { isSignedIn, submitReport } from "@/lib/feedback/submit";
import { msg, t } from "@/lib/i18n";
import { log } from "@/lib/util/log";
import { errText } from "@/lib/util/util";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ATTACHMENT_PREFS, type SubmittedReport } from "@/store/feedback";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";

const KINDS: Array<{ value: ReportKind; label: string }> = [
	{ value: "bug", label: msg("Something is broken") },
	{ value: "idea", label: msg("Suggestion") },
];

/** Stands in for an image's URL in the preview: it has none until the report is sent. */
const PENDING_URL = "uploaded when you send";

const ATTACHMENTS: Array<{ key: keyof Attachments; label: string }> = [
	{ key: "diagnostics", label: msg("App version, system and plugins") },
	{ key: "settings", label: msg("Settings you've changed") },
	{ key: "log", label: msg("Recent log") },
];

export function ReportDialog({ onClose }: { onClose: () => void }) {
	const [kind, setKind] = useState<ReportKind>("bug");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [steps, setSteps] = useState("");
	const [attachPrefs, setAttachPrefs] = useLocalStorage(ATTACHMENT_PREFS);
	const attach = attachPrefs[kind];
	const [showPreview, setShowPreview] = useState(false);
	const [images, setImages] = useState<StagedImage[]>([]);
	// One staging dir for the dialog's lifetime, created on the first attachment.
	const session = useRef<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	const [signedIn, setSignedIn] = useState(false);
	const [anonAvailable, setAnonAvailable] = useState(true);
	const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
	const [logTail, setLogTail] = useState("");
	const [ready, setReady] = useState(false);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState<SubmittedReport | null>(null);

	useEffect(() => {
		void (async () => {
			const [who, anon, diag, tail] = await Promise.all([
				isSignedIn(),
				cmd.feedbackAnonymousAvailable().catch(() => false),
				collectDiagnostics().catch((e) => {
					log.warn(`[feedback] diagnostics failed: ${e}`);
					return null;
				}),
				cmd.feedbackLogTail().catch((e) => {
					log.warn(`[feedback] log tail failed: ${e}`);
					return "";
				}),
			]);
			setSignedIn(who);
			setAnonAvailable(anon);
			setDiagnostics(diag);
			setLogTail(tail);
			setReady(true);
		})();
	}, []);

	// Staged copies and their object URLs are the dialog's to clean up -- on close, and only on
	// close. Keyed on `images` this would discard the staging dir the moment a second image was
	// added, and the next write would land in a directory that no longer exists.
	const staged = useRef<StagedImage[]>([]);
	staged.current = images;
	useEffect(
		() => () => {
			staged.current.forEach((i) => URL.revokeObjectURL(i.preview));
			if (session.current) void cmd.storeUploadAbort(session.current).catch(() => {});
		},
		[],
	);

	const addImages = async (files: FileList | null) => {
		if (!files?.length) return;
		setError(null);
		try {
			session.current ??= await cmd.storeUploadBegin();
			const room = MAX_ATTACHMENTS - images.length;
			const staged: StagedImage[] = [];
			for (const [i, file] of [...files].slice(0, room).entries()) {
				staged.push(await stageImage(session.current, file, images.length + i));
			}
			setImages((prev) => [...prev, ...staged]);
		} catch (e) {
			setError(errText(e));
		}
	};

	const removeImage = (image: StagedImage) => {
		URL.revokeObjectURL(image.preview);
		setImages((prev) => prev.filter((i) => i.id !== image.id));
	};

	const anonymous = !signedIn;
	const input = useMemo<ReportInput>(
		() => ({ kind, title: title.trim(), description, steps }),
		[kind, title, description, steps],
	);
	// The preview is composed before anything is uploaded, so it stands in for the URLs the
	// images will get rather than pretending to know them.
	const body = useMemo(
		() =>
			diagnostics
				? buildIssueBody(input, diagnostics, {
						anonymous,
						attach,
						logTail,
						images: images.map((i) => ({ name: i.name, url: PENDING_URL })),
					})
				: "",
		[input, diagnostics, anonymous, attach, logTail, images],
	);

	const blocked = !title.trim() || !description.trim() || !diagnostics;
	const cannotSend = anonymous && !anonAvailable;
	const withheld = kind === "bug" && ATTACHMENTS.some(({ key }) => !attach[key]);

	const send = async () => {
		setSending(true);
		setError(null);
		try {
			// Images have to exist before the body can point at them, so they go first -- and a
			// failure here stops the report rather than filing one with broken references.
			const uploaded = images.length && diagnostics ? await uploadImages(images) : [];
			const finalBody = diagnostics
				? buildIssueBody(input, diagnostics, { anonymous, attach, logTail, images: uploaded })
				: body;
			setSent(await submitReport(input, finalBody, anonymous));
		} catch (e) {
			setError(errText(e));
		} finally {
			setSending(false);
		}
	};

	const signIn = async () => {
		setError(null);
		try {
			const info = await cmd.githubStartLogin();
			await openExternal(info.verificationUri);
			// The code has to be visible while the browser tab is open, so it goes in the
			// error slot's calmer sibling rather than a toast that would vanish.
			setError(
				t("Enter code {code} in your browser to finish signing in.", { code: info.userCode }),
			);
			await cmd.githubPollLogin();
			setSignedIn(true);
			setError(null);
		} catch (e) {
			setError(String(e));
		}
	};

	if (!ready) return null;

	if (sent) {
		return (
			<Dialog open onOpenChange={(open) => !open && onClose()}>
				<DialogContent title={t("Report sent")} className="report-dialog">
					<p className="report-dialog__sent">
						{sent.anonymous
							? t("Thanks. Replies show up in Settings, under Feedback. Check back there.")
							: t("Thanks. This was filed on your GitHub account, so replies reach you there too.")}
					</p>
					<div className="report-dialog__actions">
						<Button onClick={() => void openExternal(sent.url)}>
							<Icon path={mdiOpenInNew} size={14} /> {t("View report")}
						</Button>
						<Button variant="primary" onClick={onClose}>
							{t("Done")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				title={t("Send feedback")}
				className="report-dialog"
				// Pasting a screenshot is how most people have one to hand.
				onPaste={(e) => void addImages(e.clipboardData.files)}
			>
				<div className="report-dialog__kinds">
					{KINDS.map((k) => (
						<label key={k.value} className="report-dialog__kind">
							<Radio
								name="report-kind"
								checked={kind === k.value}
								onChange={() => setKind(k.value)}
							/>
							{t(k.label)}
						</label>
					))}
				</div>

				{/* The one region that flexes. The preview takes it over rather than being wedged in
				    below, so showing it costs no height and nothing else moves. */}
				<div className="report-dialog__area">
					{showPreview ? (
						<pre className="report-dialog__preview">{body}</pre>
					) : (
						<div className="report-dialog__fields">
							<TextInput
								autoFocus
								placeholder={t("Title")}
								value={title}
								onChange={(e) => setTitle(e.target.value)}
							/>
							<textarea
								className="text-input report-dialog__body"
								placeholder={
									kind === "bug"
										? t("What happened, and what did you expect?")
										: t("What would you like?")
								}
								value={description}
								onChange={(e) => setDescription(e.target.value)}
							/>
							{kind === "bug" && (
								<textarea
									className="text-input report-dialog__body report-dialog__body--steps"
									placeholder={t("Steps to reproduce (optional)")}
									value={steps}
									onChange={(e) => setSteps(e.target.value)}
								/>
							)}
						</div>
					)}
				</div>

				<div className="report-dialog__images">
					{images.map((image) => (
						<div key={image.id} className="report-dialog__image">
							<img src={image.preview} alt={image.name} title={image.name} />
							<button
								type="button"
								className="icon-button report-dialog__image-remove"
								title={t("Remove")}
								onClick={() => removeImage(image)}
							>
								<Icon path={mdiClose} size={12} />
							</button>
						</div>
					))}
					{images.length < MAX_ATTACHMENTS && (
						<button
							type="button"
							className="report-dialog__image-add"
							onClick={() => fileInput.current?.click()}
							title={t("Attach an image, or paste one")}
						>
							<Icon path={mdiImagePlus} size={20} />
						</button>
					)}
					<input
						ref={fileInput}
						type="file"
						accept="image/png,image/jpeg,image/gif,image/webp"
						multiple
						hidden
						onChange={(e) => {
							void addImages(e.target.files);
							e.target.value = "";
						}}
					/>
				</div>

				<div className="report-dialog__meta">
					<div className="report-dialog__attachments">
						{ATTACHMENTS.map(({ key, label }) => (
							<label key={key} className="report-dialog__option">
								<Checkbox
									checked={attach[key]}
									onChange={(e) =>
										setAttachPrefs((prev) => ({
											...prev,
											[kind]: { ...prev[kind], [key]: e.target.checked },
										}))
									}
								/>
								{t(label)}
							</label>
						))}
					</div>
					{/* Always present, only revealed: unchecking a box must not move the rest. */}
					<p className={`report-dialog__nudge${withheld ? "" : " report-dialog__nudge--idle"}`}>
						{t("Attaching these makes bugs far easier to fix!")}
					</p>

					<div className="report-dialog__identity">
						{signedIn ? (
							<span className="report-dialog__muted">
								{t("Filing on your GitHub account. Replies reach you on GitHub.")}
							</span>
						) : (
							<>
								<span className="report-dialog__muted">
									{anonAvailable
										? t(
												"Filing anonymously. Replies come back here in the app; sign in to get them on GitHub too.",
											)
										: t("Anonymous reporting is unavailable in this build. Sign in to send.")}
								</span>
								<Button small onClick={() => void signIn()}>
									<Icon path={mdiGithub} size={14} /> {t("Sign in with GitHub")}
								</Button>
							</>
						)}
					</div>

					<button
						type="button"
						className="report-dialog__toggle"
						onClick={() => setShowPreview((v) => !v)}
					>
						{showPreview ? t("Back to the form") : t("Show exactly what will be sent")}
					</button>

					{/* Always present: an error appearing must not resize the writing area. */}
					<p className="report-dialog__error">{error}</p>
				</div>

				<div className="report-dialog__actions">
					<Button onClick={onClose}>{t("Cancel")}</Button>
					<Button
						variant="primary"
						disabled={blocked || sending || cannotSend}
						onClick={() => void send()}
					>
						{sending ? t("Sending...") : t("Send")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
