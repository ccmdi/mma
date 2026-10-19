import { useMemo, useState } from "react";
import { mdiGithub } from "@mdi/js";
import { Button } from "@/components/primitives/Button";
import { Checkbox } from "@/components/primitives/Checkbox";
import {
	Dialog,
	DialogActions,
	DialogContent,
	type DialogProps,
} from "@/components/primitives/Dialog";
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
import { uploadImages, useStagedImages } from "@/lib/feedback/attachments";
import { collectDiagnostics, type Diagnostics } from "@/lib/diagnostics";
import { useAsync, useSticky } from "@/lib/hooks/useAsync";
import { isSignedIn, submitReport } from "@/lib/feedback/submit";
import { msg, t } from "@/lib/i18n";
import { log } from "@/lib/util/log";
import { errText } from "@/lib/util/format";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ATTACHMENT_LABELS, ATTACHMENT_PREFS } from "@/store/feedback";
import { openDialog } from "@/store/dialogBus";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { ReportImages } from "./ReportImages";

const KINDS: Array<{ value: ReportKind; label: string }> = [
	{ value: "bug", label: msg("Something is broken") },
	{ value: "idea", label: msg("Suggestion") },
];

/** Stands in for an image's URL in the preview: it has none until the report is sent. */
const PENDING_URL = "uploaded when you send";

const ATTACHMENT_KEYS = Object.keys(ATTACHMENT_LABELS) as Array<keyof Attachments>;

const NOTHING_GATHERED = { diagnostics: null as Diagnostics | null, logTail: "" };

export function ReportDialog({ open, onOpenChange }: DialogProps) {
	const [kind, setKind] = useState<ReportKind>("bug");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [steps, setSteps] = useState("");
	const [attachPrefs, setAttachPrefs] = useLocalStorage(ATTACHMENT_PREFS);
	const attach = attachPrefs[kind];
	const [showPreview, setShowPreview] = useState(false);
	const { images, add, remove } = useStagedImages();

	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const account = useAsync(() => isSignedIn(), []);
	const known = useSticky(account);
	const signedIn = known.ok() ?? false;
	const gathered = useAsync(async () => {
		const [diagnostics, logTail] = await Promise.all([
			collectDiagnostics().catch((e) => {
				log.warn(`[feedback] diagnostics failed: ${e}`);
				return null;
			}),
			cmd.feedbackLogTail().catch((e) => {
				log.warn(`[feedback] log tail failed: ${e}`);
				return "";
			}),
		]);
		return { diagnostics, logTail };
	}, []);
	const { diagnostics, logTail } = gathered.ok() ?? NOTHING_GATHERED;

	const addImages = async (files: FileList | null) => {
		setError(null);
		try {
			await add(files);
		} catch (e) {
			setError(errText(e));
		}
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
	const withheld = kind === "bug" && ATTACHMENT_KEYS.some((key) => !attach[key]);

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
			const report = await submitReport(input, finalBody, anonymous);
			onOpenChange(false);
			openDialog("report-thread", report.number);
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
			await account.rerun();
			setError(null);
		} catch (e) {
			setError(errText(e));
		}
	};

	if (gathered.status !== "ok" || known.status === "loading") return null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				title={t("Send feedback")}
				className="report-dialog"
				// Pasting a screenshot is how most people have one to hand.
				onPaste={(e) => void addImages(e.clipboardData.files)}
			>
				<div className="report-dialog__kinds">
					{KINDS.map((k) => (
						<Radio
							key={k.value}
							name="report-kind"
							checked={kind === k.value}
							onChange={() => setKind(k.value)}
						>
							{t(k.label)}
						</Radio>
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
					<ReportImages images={images} onAdd={(f) => void addImages(f)} onRemove={remove} />
				</div>

				<div className="report-dialog__meta">
					<div className="report-dialog__attachments">
						{ATTACHMENT_KEYS.map((key) => (
							<Checkbox
								key={key}
								checked={attach[key]}
								onChange={(e) =>
									setAttachPrefs((prev) => ({
										...prev,
										[kind]: { ...prev[kind], [key]: e.target.checked },
									}))
								}
							>
								{t(ATTACHMENT_LABELS[key])}
							</Checkbox>
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
									{t(
										"Filing anonymously. Replies come back here in the app; sign in to get them on GitHub too.",
									)}
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

				<DialogActions
					cancel
					primary={{
						label: sending ? t("Sending...") : t("Send"),
						disabled: blocked || sending,
						onClick: () => void send(),
					}}
				/>
			</DialogContent>
		</Dialog>
	);
}
