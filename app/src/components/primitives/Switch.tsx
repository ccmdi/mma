export function Switch({
	checked,
	onChange,
	disabled,
	label,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
	label?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			title={label}
			className={`switch${checked ? " switch--on" : ""}`}
			onClick={() => onChange(!checked)}
			disabled={disabled}
		>
			<span className="switch__thumb" />
		</button>
	);
}
