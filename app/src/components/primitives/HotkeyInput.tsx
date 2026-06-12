import { useState } from "react";
import { formatBinding, buildComboString } from "@/lib/hooks/useHotkey";

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
		<input
			className="input"
			type="text"
			readOnly
			value={recording ? "" : value ? formatBinding(value) : ""}
			placeholder={recording ? "Press a key..." : "None"}
			onFocus={() => setRecording(true)}
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
