/* Panos as the Rust decoder answers them, lifted from the captured GetMetadata response in
 * `app/src-tauri/src/sv/testdata/getmetadata.golden.json`. Real coverage: a car pano with a
 * two-entry timeline, a scout capture and a user upload. */
import type { Pano } from "@/bindings.gen";

/** Official car coverage in Kursk Oblast, with links and a 2013 capture in its timeline. */
export const CAR_PANO: Pano = {
	pano: "-zrYsLR4Fh-cfJG_EMZ1-A",
	panoFrontend: 2,
	worldSize: {
		width: 13312,
		height: 6656,
	},
	tileSize: {
		width: 512,
		height: 512,
	},
	copyright: "© 2026 Google",
	description: "А142, Kursk Oblast",
	shortDescription: "А142",
	uploaderName: null,
	lat: 52.10947502806108,
	lng: 34.90131410856584,
	altitude: 206.81256103515625,
	pov: {
		heading: 227.98912048339844,
		tilt: 89.98387145996094,
		roll: 0.8096137046813965,
	},
	countryCode: "RU",
	levelId: null,
	links: [
		{
			pano: "u_RkcPj3naSx6z2tpX_8QQ",
			heading: 48.51864242553711,
		},
		{
			pano: "bFRvVCz1nW8wfQUb5hjZVw",
			heading: 228.57041931152344,
		},
	],
	time: [
		{
			pano: "NCdpiKH9MUMzPzMShzBq4Q",
			date: "2013-05-01",
		},
		{
			pano: "-zrYsLR4Fh-cfJG_EMZ1-A",
			date: "2018-09-01",
		},
	],
	date: {
		year: 2018,
		month: 9,
		day: 0,
	},
	source: "launch",
	imageDate: "2018-09",
	coverageDates: ["2013-05", "2018-09"],
	centerHeading: 227.98912048339844,
	cameraFrame: {
		heading: 227.98912048339844,
		pitch: -0.01096262829219892,
	},
	cameraType: "gen2",
};

/** A special-collects capture, which reads as a trekker. */
export const SCOUT_PANO: Pano = {
	pano: "5upMz1_zTGPdkIXG6_QM3g",
	panoFrontend: 2,
	worldSize: {
		width: 13312,
		height: 6656,
	},
	tileSize: {
		width: 512,
		height: 512,
	},
	copyright: "© 2026 Google",
	description: "",
	shortDescription: "",
	uploaderName: null,
	lat: 55.510656077142514,
	lng: 157.6366269545869,
	altitude: 884.8333129882812,
	pov: {
		heading: 354.19378662109375,
		tilt: 85.28804779052734,
		roll: 2.226807117462158,
	},
	countryCode: null,
	levelId: null,
	links: [
		{
			pano: "tWk1YQmDuRl34JxntGmKQA",
			heading: 176.35621643066406,
		},
	],
	time: [
		{
			pano: "5upMz1_zTGPdkIXG6_QM3g",
			date: "2015-09-01",
		},
	],
	date: {
		year: 2015,
		month: 9,
		day: 0,
	},
	source: "scout",
	imageDate: "2015-09",
	coverageDates: ["2015-09"],
	centerHeading: 354.19378662109375,
	cameraFrame: {
		heading: 354.19378662109375,
		pitch: 4.665717104569593,
	},
	cameraType: "trekker",
};

/** A user upload: its own frontend, no links. */
export const USER_PANO: Pano = {
	pano: "CAoSF0NJSE0wb2dLRUlDQWdJQ0VtX2l4cXdF",
	panoFrontend: 10,
	worldSize: {
		width: 7776,
		height: 3888,
	},
	tileSize: {
		width: 512,
		height: 512,
	},
	copyright: "Images may be subject to copyright.",
	description: "",
	shortDescription: "",
	uploaderName: "Johnny Béguin",
	lat: 48.8583700925299,
	lng: 2.29448130096829,
	altitude: 0,
	pov: {
		heading: 0,
		tilt: 90,
		roll: 0,
	},
	countryCode: null,
	levelId: null,
	links: [],
	time: [
		{
			pano: "CAoSF0NJSE0wb2dLRUlDQWdJQ0VtX2l4cXdF",
			date: "2016-10-16",
		},
	],
	date: {
		year: 2016,
		month: 10,
		day: 16,
	},
	source: "photos:gmm_android",
	imageDate: "2016-10",
	coverageDates: ["2016-10"],
	centerHeading: 0,
	cameraFrame: {
		heading: 0,
		pitch: 0,
	},
	cameraType: null,
};
