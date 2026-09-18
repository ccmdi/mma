import { useRef, useState, type ComponentPropsWithRef } from "react";
import { mdiClose } from "@mdi/js";
import clsx from "clsx";
import { t } from "@/lib/i18n";
import { setInputValue } from "@/lib/util/dom";
import { IconButton } from "@/components/primitives/IconButton";
import { TextInput } from "@/components/primitives/TextInput";

/** A text field for searching or filtering, with a clear button while it holds text. Escape
 *  clears it when it has text and otherwise passes through. */
export function SearchInput({
	className,
	style,
	ref,
	onChange,
	onKeyDown,
	...props
}: Omit<ComponentPropsWithRef<"input">, "type">) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [typed, setTyped] = useState(() => String(props.defaultValue ?? "") !== "");
	const filled = props.value !== undefined ? String(props.value) !== "" : typed;

	const clear = () => {
		const input = inputRef.current;
		if (!input) return;
		setInputValue(input, "");
		input.focus();
	};

	return (
		<span className={clsx("search-input", className)} style={style}>
			<TextInput
				{...props}
				ref={(node) => {
					inputRef.current = node;
					if (typeof ref === "function") return ref(node);
					if (ref) ref.current = node;
				}}
				type="text"
				className={
					filled ? "search-input__field search-input__field--filled" : "search-input__field"
				}
				onChange={(e) => {
					setTyped(e.target.value !== "");
					onChange?.(e);
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape" && e.currentTarget.value !== "") {
						e.preventDefault();
						e.stopPropagation();
						clear();
						return;
					}
					onKeyDown?.(e);
				}}
			/>
			{filled && (
				<IconButton
					className="search-input__clear"
					icon={mdiClose}
					size={16}
					label={t("Clear search")}
					tooltip={false}
					onClick={clear}
				/>
			)}
		</span>
	);
}
