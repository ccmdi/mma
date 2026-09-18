import type { CSSProperties } from "react";
import { t } from "@/lib/i18n";

/** A spinning ring shown while something loads. `size` is any length, such as `"10px"`. */
export function Spinner({ size, label }: { size?: string; label?: string }) {
	return (
		<span
			className="spinner"
			role="status"
			aria-label={label ?? t("Loading")}
			style={size ? ({ "--spinner-size": size } as CSSProperties) : undefined}
		/>
	);
}
