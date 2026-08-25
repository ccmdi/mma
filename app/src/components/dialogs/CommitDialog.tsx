import { useState } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
import { commitMap } from "@/store/useMapStore";
import { useCommitDiff } from "@/store/commitDiff";
import { t } from "@/lib/i18n";
import { fmt } from "@/lib/util/format";
import { TextInput } from "@/components/primitives/TextInput";

export function CommitDialog({ onClose }: { onClose: () => void }) {
	const diff = useCommitDiff();
	const [message, setMessage] = useState("");
	const commit = () => {
		void commitMap(message.trim() || undefined);
		onClose();
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent title={t("Commit changes")} className="commit-dialog">
				<span className="map-meta__count mono">
					<span className="map-meta__count--added">+{fmt.format(diff.added)}</span>{" "}
					<span className="map-meta__count--removed">-{fmt.format(diff.removed)}</span>{" "}
					<span className="map-meta__count--updated">&plusmn;{fmt.format(diff.modified)}</span>
				</span>
				<TextInput
					type="text"
					autoFocus
					className="commit-dialog__message"
					placeholder={t("Commit message (optional)")}
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") commit();
					}}
				/>
				<div className="commit-dialog__actions">
					<Button onClick={onClose}>{t("Cancel")}</Button>
					<Button variant="primary" onClick={commit}>
						{t("Commit")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
