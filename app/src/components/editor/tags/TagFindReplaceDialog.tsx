import { useState } from "react";
import { getVisibleTags, updateTags } from "@/store/useMapStore";
import { TagPill } from "@/components/primitives/TagPill";
import {
	Dialog,
	DialogActions,
	DialogContent,
	type DialogProps,
} from "@/components/primitives/Dialog";
import { Hint, Notice } from "@/components/primitives/Hint";
import { TextInput } from "@/components/primitives/TextInput";
import { t } from "@/lib/i18n";

export function TagFindReplaceDialog({ open, onOpenChange }: DialogProps) {
	const [find, setFind] = useState("");
	const [replace, setReplace] = useState("");
	const [applied, setApplied] = useState(false);

	const tags = getVisibleTags();
	const matches = find ? tags.filter((t) => t.name.toLowerCase().includes(find.toLowerCase())) : [];

	const handleApply = async () => {
		if (!find || matches.length === 0) return;
		const patches = matches.map((t) => ({
			id: t.id,
			patch: {
				name: t.name.replaceAll(new RegExp(RegExp.escape(find), "gi"), replace),
			},
		}));
		await updateTags(patches);
		setApplied(true);
	};

	const handleOpenChange = (v: boolean) => {
		if (!v) {
			setFind("");
			setReplace("");
			setApplied(false);
		}
		onOpenChange(v);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent title={t("Find and replace in tag names")}>
				<div className="modal__stack">
					<label className="tag-find-replace__field">
						<span>{t("Find")}</span>
						<TextInput
							value={find}
							onChange={(e) => {
								setFind(e.target.value);
								setApplied(false);
							}}
							placeholder={t("Text to find...")}
							autoFocus
						/>
					</label>
					<label className="tag-find-replace__field">
						<span>{t("Replace")}</span>
						<TextInput
							value={replace}
							onChange={(e) => {
								setReplace(e.target.value);
								setApplied(false);
							}}
							placeholder={t("Replace with...")}
						/>
					</label>
					{find && (
						<div>
							<Hint>
								{t(
									{ one: "{n} tag will be affected:", other: "{n} tags will be affected:" },
									{ n: matches.length },
								)}
							</Hint>
							<ul className="tag-find-replace__list">
								{matches.map((t) => (
									<li key={t.id}>
										<TagPill small color={t.color} label={t.name} />
										<span className="text-muted">&rarr;</span>
										<TagPill
											small
											color={t.color}
											label={t.name.replaceAll(new RegExp(RegExp.escape(find), "gi"), replace)}
										/>
									</li>
								))}
							</ul>
						</div>
					)}
					<Hint tone="warning">{t("Tag renames cannot be undone.")}</Hint>
					{applied ? (
						<DialogActions
							start={<Notice tone="success">{t("Done!")}</Notice>}
							cancel={{ label: t("Close") }}
						/>
					) : (
						<DialogActions
							cancel
							primary={{
								label: t(
									{ one: "Replace {n} tag", other: "Replace {n} tags" },
									{ n: matches.length },
								),
								disabled: !find || matches.length === 0,
								onClick: () => void handleApply(),
							}}
						/>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
