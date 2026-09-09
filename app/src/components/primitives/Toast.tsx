import { getToasts } from "@/lib/util/toast";
import { useEventValue } from "@/lib/events";

export function ToastContainer() {
	const entries = useEventValue("toasts:changed", getToasts);
	if (entries.length === 0) return null;
	return (
		<div className="toast-container">
			{entries.map((entry) => (
				<div key={entry.id} className="toast-entry">
					<span>{entry.message}</span>
				</div>
			))}
		</div>
	);
}
