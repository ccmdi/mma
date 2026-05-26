import { Dialog, DialogContent } from "@/components/primitives/Dialog";

export function GuideDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="Guide" className="guide-dialog">
				<div className="guide-content">
					<h2>MMA vs map-making.app</h2>
					<p>
						MMA is a local-first desktop clone of{" "}
						<a href="https://map-making.app" target="_blank" rel="noopener noreferrer">
							map-making.app
						</a>
						. It runs entirely on your machine with no server dependency.
					</p>

					<h3>Importing your maps</h3>
					<p>
						You can export your maps in bulk via "Download data" on the web app. Then, you can
						simply import that ZIP file ("Import maps" at the bottom right). This may take a few
						minutes.
					</p>

					<h3>What's different</h3>
					<ul>
						<li>
							<strong>No account or server</strong> -- everything is stored locally. No login or
							cloud sync.
						</li>
						<li>
							<strong>Extremely fast and scalable</strong> -- maps scale to millions of locations
							with ease.
						</li>
						<li>
							<strong>Commit-based saving</strong> -- "saves" are now "commits" which give you
							diffs. This gives you a full version history you can browse and revert.
						</li>
						<li>
							<strong>Editor state restore</strong> -- the editor keeps working changes without you
							saving, so you can pick up where you left off without keeping tabs open.
						</li>
						<li>
							<strong>Selection algebra</strong> -- selections are now draggable and can be composed
							with each other.
						</li>
					</ul>

					<h3>What's new in MMA</h3>
					<ul>
						<li>
							<strong>Plugin system</strong> -- extensible via plugins (generator, validator, JSON
							editor, and more coming).
						</li>
						<li>
							<strong>Customizable hotkeys</strong> -- rebind any keyboard shortcut in Settings.
						</li>
						<li>
							<strong>Custom CSS</strong> -- inject your own styles via Settings.
						</li>
						<li>
							<strong>Coverage generator</strong> -- MapGenerator clone integrated into the editor.
						</li>
						<li>
							<strong>Metadata enrichment</strong> -- fetch altitude, camera type, country code, and
							exact capture dates.
						</li>
						<li>
							<strong>Pano controls</strong> -- jump forward/backward, compass, coordinate display,
							fullscreen with minimap.
						</li>
						<li>
							<strong>Bulk import/export</strong> -- import and export all maps at once as a single
							archive.
						</li>
					</ul>
				</div>
			</DialogContent>
		</Dialog>
	);
}
