import { useEffect, useRef } from "react";
import { Icon } from "@/components/primitives/Icon";
import { mdiClose, mdiChevronLeft, mdiChevronRight } from "@mdi/js";
import { CHAPTERS } from "@/components/manual/chapters";
import { MANUAL_COMPONENTS, ManualNav } from "@/components/manual/components";
import { useHotkey } from "@/lib/hooks/useHotkey";
import "@/components/manual/manual.css";
import { t } from "@/lib/i18n";

export function Manual({
	chapterId,
	onNavigate,
	onClose,
}: {
	chapterId: string;
	onNavigate: (id: string) => void;
	onClose: () => void;
}) {
	const found = CHAPTERS.findIndex((c) => c.id === chapterId);
	const index = found >= 0 ? found : 0;
	const contentRef = useRef<HTMLDivElement>(null);
	const chapter = CHAPTERS[index];
	const Body = chapter.Body;

	useHotkey("escape", onClose);

	useEffect(() => {
		contentRef.current?.scrollTo(0, 0);
	}, [chapterId]);

	const go = (i: number) => {
		if (i >= 0 && i < CHAPTERS.length) onNavigate(CHAPTERS[i].id);
	};

	return (
		<ManualNav.Provider value={onNavigate}>
			<div className="manual">
				<aside className="manual__sidebar">
					<div className="manual__sidebar-head">
						<span className="manual__title">{t("Manual")}</span>
						<button className="icon-button" onClick={onClose} aria-label={t("Close manual")}>
							<Icon path={mdiClose} />
						</button>
					</div>
					<nav className="manual__toc">
						<ol>
							{CHAPTERS.map((c, i) => (
								<li key={c.id}>
									<button
										className={`nav-item manual__toc-link${i === index ? " nav-item--active" : ""}`}
										onClick={() => go(i)}
									>
										{c.title}
									</button>
								</li>
							))}
						</ol>
					</nav>
				</aside>
				<main className="manual__main" ref={contentRef}>
					<article className="manual__content">
						<h1>{chapter.title}</h1>
						<Body components={MANUAL_COMPONENTS} />
					</article>
					<nav className="manual__nav">
						{index > 0 && (
							<button className="manual__nav-btn" onClick={() => go(index - 1)}>
								<Icon path={mdiChevronLeft} size={18} />
								{CHAPTERS[index - 1].title}
							</button>
						)}
						{index < CHAPTERS.length - 1 && (
							<button
								className="manual__nav-btn manual__nav-btn--next"
								onClick={() => go(index + 1)}
							>
								{CHAPTERS[index + 1].title}
								<Icon path={mdiChevronRight} size={18} />
							</button>
						)}
					</nav>
				</main>
			</div>
		</ManualNav.Provider>
	);
}
