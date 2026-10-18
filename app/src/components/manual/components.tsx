/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode, type ComponentPropsWithoutRef } from "react";
import { MANUAL_IMG_DIMS } from "@/components/manual/manual-img-dims.gen";
import { chapterTitle } from "@/components/manual/chapters";
import { APP_NAME } from "@/lib/util/format";
import { Kbd } from "@/components/primitives/Kbd";

// --- Content primitives, provided to every MDX chapter via the `components` prop ---

function Note({ children }: { children: ReactNode }) {
	return <div className="manual-note">{children}</div>;
}

// Images are fetched from GitHub at runtime so the manual ships without bundling
// screenshots; dev reads the local ones. If the file is missing or the user is offline,
// the <img> hides itself and only the caption remains, keeping the layout clean.
const MANUAL_IMG_BASE = import.meta.env.DEV
	? "/img/manual/"
	: "https://raw.githubusercontent.com/ccmdi/mma/master/img/manual/";

function Img({ name, caption }: { name: string; caption: string }) {
	const dim = MANUAL_IMG_DIMS[name];
	return (
		<figure className="manual-figure">
			<img
				key={name}
				className="manual-figure__img"
				src={MANUAL_IMG_BASE + name}
				alt={caption}
				loading="lazy"
				width={dim?.w}
				height={dim?.h}
				style={dim ? { aspectRatio: `${dim.w} / ${dim.h}` } : undefined}
				onError={(e) => {
					(e.currentTarget as HTMLImageElement).style.display = "none";
				}}
			/>
			<figcaption className="manual-figure__caption">{caption}</figcaption>
		</figure>
	);
}

// Navigation injected by the Manual view so cross-references can jump chapters.
export const ManualNav = createContext<(id: string) => void>(() => {});

// A clickable cross-reference to another chapter, on the words it wraps, or the
// chapter's current title when it wraps nothing.
function ChapterLink({ id, children }: { id: string; children?: ReactNode }) {
	const go = useContext(ManualNav);
	return (
		<button type="button" className="manual-xref" onClick={() => go(id)}>
			{children ?? chapterTitle(id)}
		</button>
	);
}

// Markdown links render as <a>; route external ones to the browser.
function MdxLink({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) {
	const external = !!href && /^https?:/i.test(href);
	const target = external ? { target: "_blank", rel: "noopener noreferrer" } : {};
	return (
		<a href={href} {...target} {...rest}>
			{children}
		</a>
	);
}

function App() {
	return <>{APP_NAME}</>;
}

export const MANUAL_COMPONENTS = { Kbd, Note, Img, ChapterLink, App, a: MdxLink };
