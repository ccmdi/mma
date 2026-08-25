import { useState } from "react";
import { formatBinding, buildComboString } from "@/lib/hooks/useHotkey";
import { t } from "@/lib/i18n";
import { TextInput } from "./TextInput";

/** Click-to-record key combo input. Backspace/Delete clears, Escape cancels. */
export function HotkeyInput({
	value,
	onChange,
}: {
	value: string;
	onChange: (combo: string) => void;
}) {
	const [recording, setRecording] = useState(false);
	return (
		<TextInput
			type="text"
			readOnly
			value={recording ? "" : value ? formatBinding(value) : ""}
			placeholder={recording ? t("Press a key...") : t("None")}
			onClick={() => setRecording(true)}
			onBlur={() => setRecording(false)}
			onKeyDown={(e) => {
				if (!recording) return;
				e.preventDefault();
				e.stopPropagation();
				if (e.key === "Escape") {
					e.currentTarget.blur();
					return;
				}
				if (e.key === "Backspace" || e.key === "Delete") {
					onChange("");
					return;
				}
				const combo = buildComboString(e.nativeEvent);
				if (!combo) return;
				onChange(combo);
				e.currentTarget.blur();
			}}
		/>
	);
}
