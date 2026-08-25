/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useRef, useState } from "react";
import { events } from "@/bindings.gen";
import type { ValiCountryStatus, ValiProgress } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { SwitchRow } from "@/components/primitives/SwitchRow";
import { countryName, fmt, formatBytes } from "@/lib/util/format";
import { msg, t } from "@/lib/i18n";
import { log } from "@/lib/util/log";

/** One `--country` argument. `code: null` is "every country", which is deliberately not the
 *  `world` alias -- that one resolves to the default distribution, i.e. a subset. */
interface Target {
	code: string | null;
	name: string;
}

const ALIASES: { code: string | null; label: string }[] = [
	{ code: null, label: msg("All countries") },
	{ code: "europe", label: msg("Europe") },
	{ code: "asia", label: msg("Asia") },
	{ code: "africa", label: msg("Africa") },
	{ code: "northamerica", label: msg("North America") },
	{ code: "southamerica", label: msg("South America") },
	{ code: "oceania", label: msg("Oceania") },
];

const MAX_SUGGESTIONS = 40;

export interface DownloadProgress {
	/** Country code of the batch in flight. */
	country: string;
	/** This batch is the incremental updates pass rather than the full data pass. */
	updates: boolean;
	files: number;
	done: number;
	bytes: number;
	bytesDone: number;
	/** Files finished across every batch of this run. */
	filesTotal: number;
}

/** Folds `vali-progress` into download state. Vali walks countries one batch at a time, so a
 *  `countryDownloadStarted` ends the previous batch; only `filesTotal` spans batches. The
 *  generate-only events pass through untouched. */
export function downloadProgress(
	prev: DownloadProgress | null,
	event: ValiProgress,
): DownloadProgress | null {
	switch (event.kind) {
		case "countryDownloadStarted":
			return {
				country: event.countryCode,
				updates: event.updates,
				files: event.files,
				done: 0,
				bytes: event.bytes,
				bytesDone: 0,
				filesTotal: prev?.filesTotal ?? 0,
			};
		case "fileDownloaded":
			if (!prev) return prev;
			return {
				...prev,
				done: prev.done + 1,
				bytesDone: prev.bytesDone + event.bytes,
				filesTotal: prev.filesTotal + 1,
			};
		default:
			return prev;
	}
}

/** Names every out-of-date country. Empty string for "nothing stale" so callers can render
 *  it unconditionally. */
export function staleSummary(stale: ValiCountryStatus[]): string {
	if (stale.length === 0) return "";
	const countries = stale.map((s) => countryName(s.countryCode)).join(", ");
	return t("Data for {countries} is out of date.", { countries });
}

export function ValiDownloadDialog({
	open,
	onOpenChange,
	running,
	onRunningChange,
	stale,
	onDownloaded,
}: DialogProps & {
	running: boolean;
	onRunningChange: (running: boolean) => void;
	/** `null` while unknown -- the check has not run, or it failed (offline). */
	stale: ValiCountryStatus[] | null;
	onDownloaded: () => void;
}) {
	const [countries, setCountries] = useState<string[]>([]);
	const [ready, setReady] = useState(false);
	const [query, setQuery] = useState("");
	const [target, setTarget] = useState<Target | null>(null);
	const [full, setFull] = useState(false);
	const [progress, setProgress] = useState<DownloadProgress | null>(null);
	const [result, setResult] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const filesRef = useRef(0);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setTarget(null);
		setProgress(null);
		setResult(null);
		setError(null);
		cmd
			.valiCountries()
			.then(setCountries)
			.catch((e) => setError(String(e)))
			.finally(() => setReady(true));
	}, [open]);

	const targets = useMemo<Target[]>(
		() => [
			...ALIASES.map((a) => ({ code: a.code, name: t(a.label) })),
			...countries.map((code) => ({ code, name: countryName(code) })),
		],
		[countries],
	);

	const suggestions = useMemo(() => {
		const q = query.trim().toLowerCase();
		const match = q
			? targets.filter(
					(x) => x.name.toLowerCase().includes(q) || x.code?.toLowerCase().startsWith(q),
				)
			: targets;
		return match.slice(0, MAX_SUGGESTIONS);
	}, [targets, query]);

	const run = async (download: () => Promise<unknown>) => {
		if (running) return;
		setProgress(null);
		setResult(null);
		setError(null);
		filesRef.current = 0;
		onRunningChange(true);
		const unlisten = await events.valiProgress.listen((e) =>
			setProgress((p) => {
				const next = downloadProgress(p, e.payload);
				filesRef.current = next?.filesTotal ?? 0;
				return next;
			}),
		);
		try {
			await download();
			// Nothing is emitted when every local timestamp already matches the remote one.
			setResult(
				filesRef.current === 0
					? t("Already up to date.")
					: t(
							{ one: "Downloaded {n} file.", other: "Downloaded {n} files." },
							{ n: filesRef.current },
						),
			);
			onDownloaded();
		} catch (e) {
			const message = String(e);
			if (/cancel/i.test(message)) setResult(t("Cancelled."));
			else {
				log.error("[vali] download failed:", e);
				setError(message);
			}
		} finally {
			unlisten();
			onRunningChange(false);
		}
	};

	return (
		<Dialog open={open && ready} onOpenChange={running ? () => {} : onOpenChange}>
			<DialogContent title={t("Download coverage data")} className="vali-download">
				{stale && stale.length > 0 && (
					<div className="vali-download__stale">
						<span>{staleSummary(stale)}</span>
						<Button
							variant="primary"
							small
							disabled={running}
							onClick={() => void run(() => cmd.valiDownloadStale())}
						>
							{t("Update these")}
						</Button>
					</div>
				)}

				<div className="vali-download__label">{t("Country or region")}</div>
				<SuggestInput<Target>
					value={query}
					onChange={(v) => {
						setQuery(v);
						setTarget(null);
					}}
					suggestions={suggestions}
					onPick={(item) => {
						setTarget(item);
						setQuery(item.name);
					}}
					containerClassName="vali-download__picker"
					getKey={(item) => item.code ?? "_all"}
					renderItem={(item) => (
						<span className="vali-download__option">
							{item.code && item.code.length === 2 ? (
								<img
									src={`/flags/${item.code.toUpperCase()}.svg`}
									alt=""
									width={20}
									height={15}
									style={{ borderRadius: 2, flexShrink: 0 }}
								/>
							) : (
								<span className="vali-download__option-spacer" />
							)}
							{item.name}
						</span>
					)}
					placeholder={t("All countries")}
					disabled={running}
					portal
				/>

				<SwitchRow
					className="vali-download__switch"
					checked={full}
					onChange={setFull}
					disabled={running}
					label={t("Force redownload")}
				/>

				{progress && (
					<div className="vali-download__progress">
						<div className="vali-download__progress-label">
							<span>
								{progress.updates
									? t("Updating {country}", { country: countryName(progress.country) })
									: t("Downloading {country}", { country: countryName(progress.country) })}
							</span>
							<span className="mono">
								{fmt.format(progress.done)} / {fmt.format(progress.files)} (
								{formatBytes(progress.bytesDone)} / {formatBytes(progress.bytes)})
							</span>
						</div>
						<div className="vali-download__bar-track">
							<div
								className="vali-download__bar-fill"
								style={{
									width: `${progress.files > 0 ? (progress.done / progress.files) * 100 : 0}%`,
								}}
							/>
						</div>
					</div>
				)}

				{result && <div className="vali-download__result">{result}</div>}
				{error && <div className="vali-download__error">{error}</div>}

				<div className="vali-download__footer">
					{running ? (
						<Button variant="destructive" onClick={() => void cmd.valiCancel()}>
							{t("Cancel")}
						</Button>
					) : (
						<Button onClick={() => onOpenChange(false)}>{t("Close")}</Button>
					)}
					<Button
						variant="primary"
						disabled={!target || running}
						onClick={() => {
							if (target) void run(() => cmd.valiDownload(target.code, full, false));
						}}
					>
						{running ? t("Downloading...") : t("Download")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
