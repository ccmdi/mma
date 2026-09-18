import { useState } from "react";
import {
	Dialog,
	DialogActions,
	DialogContent,
	DialogForm,
	type DialogProps,
} from "@/components/primitives/Dialog";
import { DiffCounts } from "@/components/primitives/DiffCounts";
import { TextInput } from "@/components/primitives/TextInput";
import { commitMap } from "@/store/useMapStore";
import { useCommitDiff } from "@/store/commitDiff";
import { t } from "@/lib/i18n";

export function CommitDialog({ open, onOpenChange }: DialogProps) {
	const diff = useCommitDiff();
	const [message, setMessage] = useState("");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Commit changes")} size="sm" data-qa="commit-dialog">
				<DialogForm
					onSubmit={() => {
						void commitMap(message.trim() || undefined);
						onOpenChange(false);
					}}
				>
					<DiffCounts {...diff} />
					<TextInput
						type="text"
						autoFocus
						placeholder={t("Commit message (optional)")}
						value={message}
						onChange={(e) => setMessage(e.target.value)}
					/>
					<DialogActions cancel primary={{ label: t("Commit") }} />
				</DialogForm>
			</DialogContent>
		</Dialog>
	);
}
