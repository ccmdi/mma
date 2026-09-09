import { useEffect, useRef, useState } from "react";
import { mdiClose } from "@mdi/js";
import { getJobs } from "@/lib/jobs";
import { useEventValue } from "@/lib/events";
import { Icon } from "@/components/primitives/Icon";
import { t } from "@/lib/i18n";

const PEEK_MS = 2500;

/** Background-job pill for the corner bar, the update pill's sibling. Its fill tracks
 *  the least-done job; clicking toggles a popup panel of per-job rows. A new job peeks
 *  the panel open briefly so the pill's existence is learnable. */
export function JobTray() {
	const jobs = useEventValue("jobs:changed", getJobs);
	const visible = jobs.filter((j) => !j.hidden);
	const [pinned, setPinned] = useState(false);
	const [peeking, setPeeking] = useState(false);
	const peekTimer = useRef<number | null>(null);
	const prevCount = useRef(0);

	useEffect(() => {
		if (visible.length === 0) {
			setPinned(false);
			setPeeking(false);
		} else if (visible.length > prevCount.current && !pinned) {
			setPeeking(true);
			if (peekTimer.current !== null) clearTimeout(peekTimer.current);
			peekTimer.current = window.setTimeout(() => setPeeking(false), PEEK_MS);
		}
		prevCount.current = visible.length;
	}, [visible.length, pinned]);

	useEffect(
		() => () => {
			if (peekTimer.current !== null) clearTimeout(peekTimer.current);
		},
		[],
	);

	if (visible.length === 0) return null;

	const open = pinned || peeking;
	const worst = Math.min(...visible.map((j) => j.fraction));

	return (
		<div className="job-tray">
			<button
				className="job-tray__pill"
				type="button"
				aria-label={t("Background jobs")}
				aria-expanded={open}
				onClick={() => {
					setPeeking(false);
					setPinned(!open);
				}}
			>
				<div className="job-tray__pill-fill" style={{ width: `${Math.round(worst * 100)}%` }} />
				{visible.length > 1 && <span className="job-tray__count">{visible.length}</span>}
			</button>
			{open && (
				<div className="job-tray__panel">
					{visible.map((j) => (
						<div
							key={j.id}
							className={`job-tray__row${j.reveal ? " job-tray__row--reveal" : ""}`}
							onClick={j.reveal}
						>
							<span className="job-tray__row-label">{j.label}</span>
							<div className="toast-progress__track">
								<div
									className="toast-progress__bar"
									style={{ width: `${Math.round(j.fraction * 100)}%` }}
								/>
							</div>
							{j.detail && <span className="toast-progress__label">{j.detail}</span>}
							{j.cancel && (
								<button
									className="icon-button job-tray__cancel"
									type="button"
									aria-label={t("Cancel")}
									onClick={(e) => {
										e.stopPropagation();
										j.cancel?.();
									}}
								>
									<Icon path={mdiClose} size={14} />
								</button>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
