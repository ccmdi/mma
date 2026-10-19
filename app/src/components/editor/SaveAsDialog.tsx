import { useState } from "react";
import { useJob } from "@/lib/hooks/useJob";
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
	const saving = useJob();

	const save = async () => {
		if (!map || !(await confirmMapExit("leave"))) return;
		const saved = await saving.run(async () => {
			const copy = await Maps.duplicate(map.id, name.trim());
			onOpenChange(false);
			await Maps.close();
			goTo({ type: "editor", mapId: copy.id });
		});
		if (saved.status === "error") {
			toast(t("Could not save a copy: {error}", { error: errText(saved.error) }));
		}
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
			canSubmit={saving.status !== "loading" && name.trim() !== ""}
			onSubmit={() => void save()}
		/>
	);
}
