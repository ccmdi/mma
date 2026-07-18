/** Local click-to-go marker — replaces lookmap `/static/marker.png`. */
export const MOVEMENT_MARKER_URL =
	"data:image/svg+xml," +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
			<circle cx="32" cy="32" r="28" fill="#ffffff" fill-opacity="0.92"/>
			<circle cx="32" cy="32" r="10" fill="#1a73e8"/>
		</svg>`,
	);
