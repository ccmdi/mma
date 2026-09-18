import type { FocusEventHandler } from "react";
import { Button } from "@/components/primitives/Button";
import { t } from "@/lib/i18n";

/** The pill field that names a tag to add. With `onAdd`, the + button or Enter adds the typed name;
 *  without it the field only holds a name. */
export function AddTagForm({
	value,
	onChange,
	onAdd,
	onFocus,
	onBlur,
}: {
	value: string;
	onChange: (value: string) => void;
	onAdd?: () => void;
	onFocus?: FocusEventHandler<HTMLInputElement>;
	onBlur?: FocusEventHandler<HTMLInputElement>;
}) {
	const input = (
		<input
			className="form-add-tag__input"
			type="text"
			placeholder={t("Add a tag...")}
			spellCheck={false}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			onFocus={onFocus}
			onBlur={onBlur}
		/>
	);
	if (!onAdd) return <div className="form-add-tag form-add-tag--plain">{input}</div>;
	return (
		<form
			className="form-add-tag"
			onSubmit={(e) => {
				e.preventDefault();
				onAdd();
			}}
		>
			<Button className="form-add-tag__button" type="submit">
				+
			</Button>
			{input}
		</form>
	);
}
