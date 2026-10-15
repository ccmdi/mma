import { mdiAlertCircleOutline } from "@mdi/js";
import { EmptyState } from "@/components/primitives/EmptyState";
import { Button } from "@/components/primitives/Button";
import { t } from "@/lib/i18n";

/** A whole-window failure: what went wrong, and a way back to the map list when there is one. */
export function ErrorScreen({ message, onBack }: { message: string; onBack?: () => void }) {
	return (
		<div className="error-screen">
			<EmptyState icon={mdiAlertCircleOutline}>{message}</EmptyState>
			{onBack && <Button onClick={onBack}>{t("Back to maps")}</Button>}
		</div>
	);
}
