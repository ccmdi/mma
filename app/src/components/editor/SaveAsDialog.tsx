import { useState } from "react";
import { Maps } from "@/store/maps";
import { Store } from "@/store/store";
import { PromptDialog, type DialogProps } from "@/components/primitives/Dialog";
import { confirmMapExit } from "@/lib/jobs";
import { goTo } from "@/store/router";
import { toast } from "@/lib/util/toast";
import { errText } from "@/lib/util/format";
import { t } from "@/lib/i18n";

/** Copies the open map, uncommitted edits included, into a new map and opens the copy. */
export function SaveAsDialog({ open, onOpenChange }: DialogProps) {
	const map = Store.use((s) => s.map);
	const [name, setName] = useState(() => Maps.copyName(map?.name ?? ""));
	const [saving, setSaving] = useState(false);

	const save = async () => {
		if (!map || !(await confirmMapExit("leave"))) return;
		setSaving(true);
		const copy = await Maps.duplicate(map.id, name.trim()).catch((e: unknown) => {
			toast(t("Could not save a copy: {error}", { error: errText(e) }));
			setSaving(false);
			return null;
		});
		if (!copy) return;
		onOpenChange(false);
		await Maps.close();
		goTo({ type: "editor", mapId: copy.id });
	};

	return (
		<PromptDialog
			open={open}
			onOpenChange={onOpenChange}
			title={t("Save as")}
			value={name}
			onChange={setName}
			selectOnFocus
			submitLabel={t("Save")}
			canSubmit={!saving && name.trim() !== ""}
			onSubmit={() => void save()}
		/>
	);
}
