import { mdiClose } from "@mdi/js";
import { getToasts } from "@/lib/util/toast";
import { getJobs } from "@/lib/jobs";
import { useEventValue } from "@/lib/events";
import { Icon } from "@/components/primitives/Icon";
import { t } from "@/lib/i18n";

export function ToastContainer() {
	const entries = useEventValue("toasts:changed", getToasts);
	const jobs = useEventValue("jobs:changed", getJobs);
	const visibleJobs = jobs.filter((j) => !j.hidden);
	if (entries.length === 0 && visibleJobs.length === 0) return null;
	return (
		<div className="toast-container">
			{visibleJobs.map((j) => (
				<div
					key={`job-${j.id}`}
					className={`toast-entry job-entry${j.reveal ? " job-entry--reveal" : ""}`}
					onClick={j.reveal}
				>
					<span>{j.label}</span>
					<div className="toast-progress__track">
						<div
							className="toast-progress__bar"
							style={{ width: `${Math.round(j.fraction * 100)}%` }}
						/>
					</div>
					{j.detail && <span className="toast-progress__label">{j.detail}</span>}
					{j.cancel && (
						<button
							className="icon-button job-entry__cancel"
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
			{entries.map((entry) => (
				<div key={entry.id} className="toast-entry">
					<span>{entry.message}</span>
				</div>
			))}
		</div>
	);
}
