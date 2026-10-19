import { useCallback, useMemo, useState } from "react";
import { useJob } from "@/lib/hooks/useJob";
import { errText } from "@/lib/util/format";
import { Store } from "@/store/store";
import { Tag } from "@/store/tag";
import { Dialog, DialogActions, DialogContent, DialogForm } from "@/components/primitives/Dialog";
import { SuggestInput } from "@/components/primitives/SuggestInput";
import { TagPill } from "@/components/primitives/TagPill";
import { Icon } from "@/components/primitives/Icon";
import { mdiTagPlusOutline } from "@mdi/js";
import { t } from "@/lib/i18n";
import { search } from "@/lib/search";
import { toast } from "@/lib/util/toast";
import { displayTagName } from "@/lib/data/tags";

export function TagButton({ locationIds, label }: { locationIds: number[]; label?: string }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const tagging = useJob();
	const busy = tagging.status === "loading";
	const tags = Store.use(Tag.visible);

	const suggestions = useMemo(
		() => search(tags, name, (tag) => [tag.name]).slice(0, 10),
		[tags, name],
	);

	const apply = useCallback(
		async (tagName: string) => {
			const trimmed = tagName.trim();
			if (!trimmed || locationIds.length === 0) return;
			const tagged = await tagging.run(() =>
				Tag.assign({ type: "Locations", locations: locationIds, name: null }, [{ name: trimmed }]),
			);
			if (tagged.status === "error") return toast(errText(tagged.error));
			if (tagged.status !== "ok") return;
			toast(
				locationIds.length === 1
					? t("Tagged with {tag}", { tag: trimmed })
					: t("Tagged {n} locations with {tag}", { n: locationIds.length, tag: trimmed }),
			);
			setName("");
			setOpen(false);
		},
		[tagging, locationIds],
	);

	if (locationIds.length === 0) return null;

	return (
		<>
			<button
				type="button"
				className="lg-tag-btn"
				onClick={() => setOpen(true)}
				aria-label={label ?? t("Add a tag")}
			>
				<Icon path={mdiTagPlusOutline} size={18} />
				{label && <span>{label}</span>}
			</button>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent
					size="sm"
					title={
						locationIds.length === 1
							? t("Tag this location")
							: t("Tag {n} locations", { n: locationIds.length })
					}
				>
					<DialogForm onSubmit={() => void apply(name)}>
						<SuggestInput<Tag>
							value={name}
							onChange={setName}
							suggestions={suggestions}
							onPick={(tag) => void apply(tag.name)}
							renderItem={(tag) => (
								<TagPill small color={tag.color} label={displayTagName(tag.name)} />
							)}
							getKey={(tag) => tag.id}
							placeholder={t("Tag name")}
							disabled={busy}
							autoFocus
							portal
						/>
						<DialogActions
							cancel={{ disabled: busy }}
							primary={{ label: t("Add tag"), disabled: !name.trim() || busy }}
						/>
					</DialogForm>
				</DialogContent>
			</Dialog>
		</>
	);
}
