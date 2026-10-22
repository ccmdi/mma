import { useState, type ComponentPropsWithRef, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";
import { mdiAccount } from "@mdi/js";
import { Icon } from "./Icon";

/** A round picture `size` pixels wide, showing `fallback` (a plain figure by default) when there is no `src` or it fails to load, ringed in `ring` when given. */
export function Avatar({
	src,
	size = 28,
	fallback = <Icon path={mdiAccount} size={Math.round(size * 0.6 + 3)} />,
	ring,
	className,
	style,
	...props
}: ComponentPropsWithRef<"span"> & {
	src?: string | null;
	size?: number;
	fallback?: ReactNode;
	ring?: string;
}) {
	const [failed, setFailed] = useState<string | null>(null);
	const shown = src && src !== failed ? src : null;
	return (
		<span
			{...props}
			className={clsx("avatar", ring && "avatar--ring", className)}
			style={{ ...style, width: size, height: size, "--avatar-ring": ring } as CSSProperties}
		>
			{shown ? <img src={shown} alt="" onError={() => setFailed(shown)} /> : fallback}
		</span>
	);
}
