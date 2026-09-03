/** Country flag from the bundled SVG set. Renders nothing for a missing or malformed code. */
export function Flag({
	code,
	height = 15,
	className,
}: {
	code: string | null;
	height?: number;
	className?: string;
}) {
	if (!code || code.length !== 2) return null;
	const upper = code.toUpperCase();
	return (
		<img
			className={className}
			src={`/flags/${upper}.svg`}
			alt={upper}
			width={Math.round((height * 4) / 3)}
			height={height}
			style={{ borderRadius: "2px", verticalAlign: "middle" }}
		/>
	);
}
