import { useState } from "react";
import { Commit } from "@/store/commit";
import {
	Dialog,
	DialogActions,
	DialogContent,
	DialogForm,
	type DialogProps,
} from "@/components/primitives/Dialog";
import { DiffCounts } from "@/components/primitives/DiffCounts";
import { TextInput } from "@/components/primitives/TextInput";
import { CommitDiff } from "@/store/commitDiff";
import { t } from "@/lib/i18n";

export function CommitDialog({ open, onOpenChange }: DialogProps) {
	const diff = CommitDiff.use();
	const [message, setMessage] = useState("");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={t("Commit changes")} size="sm" data-qa="commit-dialog">
				<DialogForm
					onSubmit={() => {
						void Commit.create(message.trim() || undefined);
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
