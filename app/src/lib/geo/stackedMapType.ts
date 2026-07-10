import { google } from "@/lib/sv/opensv";

function waitForTileLoad(el: Element): Promise<void> {
	return new Promise((resolve) => {
		google.maps.event.addListenerOnce(el, "load", resolve);
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-created class
let StackedMapType: any = null;

// Defined lazily: the class extends google.maps.ImageMapType, which only exists
// after opensv has loaded.
function initStackedMapType() {
	if (StackedMapType) return;
	StackedMapType = class extends google.maps.ImageMapType {
		layers: google.maps.ImageMapType[];
		constructor(layers: google.maps.ImageMapType[], opts: google.maps.ImageMapTypeOptions) {
			super({ ...opts, getTileUrl: () => null });
			this.layers = layers;
		}
		getTile(coord: google.maps.Point | null, zoom: number, doc: Document | null) {
			if (!coord || !doc) return null;
			const tiles = this.layers.map((l) => l.getTile(coord, zoom, doc)!);
			const div = doc.createElement("div");
			div.append(...tiles.filter(Boolean));
			Promise.all(tiles.filter((t): t is Element => t != null).map(waitForTileLoad)).then(() => {
				google.maps.event.trigger(div, "load");
			});
			return div;
		}
		releaseTile(el: HTMLElement) {
			let i = 0;
			for (let j = 0; j < el.children.length; j++) {
				const child = el.children[j];
				if (child instanceof HTMLElement) {
					this.layers[i]?.releaseTile(child);
					i++;
				}
			}
		}
	};
}

export function createCompositeMapType(
	layers: google.maps.ImageMapType[],
): google.maps.ImageMapType {
	initStackedMapType();
	return new StackedMapType(layers, {
		tileSize: new google.maps.Size(256, 256),
		minZoom: 0,
		maxZoom: 20,
	});
}
