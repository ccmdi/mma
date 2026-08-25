import { useState } from "react";
import { getVisibleTags, updateTags } from "@/store/useMapStore";
import { TagPill } from "@/components/primitives/TagPill";
import { Dialog, DialogContent, type DialogProps } from "@/components/primitives/Dialog";
import { Button } from "@/components/primitives/Button";
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
			<DialogContent title={t("Find and replace in tag names")} className="tag-find-replace-modal">
				<div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: 4 }}>
					<label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
						<span style={{ width: 60 }}>{t("Find")}</span>
						<TextInput
							style={{ flex: 1 }}
							value={find}
							onChange={(e) => {
								setFind(e.target.value);
								setApplied(false);
							}}
							placeholder={t("Text to find...")}
							autoFocus
						/>
					</label>
					<label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
						<span style={{ width: 60 }}>{t("Replace")}</span>
						<TextInput
							style={{ flex: 1 }}
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
							<p style={{ margin: "0 0 0.25rem", fontSize: "0.85rem", color: "var(--text-2)" }}>
								{t(
									{ one: "{n} tag will be affected:", other: "{n} tags will be affected:" },
									{ n: matches.length },
								)}
							</p>
							<ul
								style={{
									margin: 0,
									padding: 0,
									listStyle: "none",
									maxHeight: 320,
									overflowY: "auto",
									fontSize: "0.85rem",
								}}
							>
								{matches.map((t) => {
									const newName = t.name.replaceAll(new RegExp(RegExp.escape(find), "gi"), replace);
									return (
										<li
											key={t.id}
											style={{ padding: "1px 0", display: "flex", alignItems: "center", gap: 6 }}
										>
											<TagPill small color={t.color} label={t.name} />
											<span style={{ opacity: 0.5 }}>&rarr;</span>
											<TagPill small color={t.color} label={newName} />
										</li>
									);
								})}
							</ul>
						</div>
					)}
					<p style={{ margin: 0, fontSize: "0.8rem", color: "var(--accent)" }}>
						{t("Tag renames cannot be undone.")}
					</p>
					<div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
						<Button onClick={() => handleOpenChange(false)}>
							{applied ? t("Close") : t("Cancel")}
						</Button>
						{!applied && (
							<Button
								variant="primary"
								disabled={!find || matches.length === 0}
								onClick={() => void handleApply()}
							>
								{t({ one: "Replace {n} tag", other: "Replace {n} tags" }, { n: matches.length })}
							</Button>
						)}
						{applied && (
							<span
								style={{ alignSelf: "center", color: "var(--constructive)", fontSize: "0.85rem" }}
							>
								{t("Done!")}
							</span>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
