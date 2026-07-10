/* Live GetMetadata captures (2026-06-10): identical request sent with and without
 * alt=proto. BIN_* is the binary response (base64); JSON_* is the json+protobuf response,
 * used as positional ground truth for schema parity. Regenerate via the capture script in
 * the PR that introduced src/lib/sv/proto/. */

// car coverage with links + time history + relations
export const BIN_CAR =
	"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";
export const JSON_CAR = [
	[0],
	[
		[
			[1],
			[2, "20C-1_sANr4OMdhTDM2N-g"],
			[
				2,
				2,
				[6656, 13312],
				[
					[
						[[208, 416]],
						[[416, 832]],
						[[832, 1664]],
						[[1664, 3328]],
						[[3328, 6656]],
						[[6656, 13312]],
					],
					[512, 512],
				],
				null,
				null,
				null,
				null,
				null,
				"20C-1_sANr4OMdhTDM2N-g",
			],
			[],
			[[[["© 2026 Google"]]]],
			[
				[
					[1],
					[
						[null, null, 48.85280369273168, 2.3526202316161253],
						[43.095886, null, 87.66117],
						[248.18436, 87.66303, 355.58524],
					],
					null,
					[
						[
							[
								[2, "20C-1_sANr4OMdhTDM2N-g"],
								null,
								[
									[null, null, 48.85280369273168, 2.3526202316161253],
									[43.095886],
									[248.18436, 87.66303, 355.58524],
								],
							],
							[
								[2, "J8rclpA1TLy4yTJ6__3hsw"],
								null,
								[
									[null, null, 48.85268533288577, 2.3526761983824276],
									[43.252823],
									[65.21948, 89.89059, 355.14343],
								],
							],
							[
								[2, "-jSCx1MhOeVP64yA7x7SAQ"],
								null,
								[
									[null, null, 48.85277595499152, 2.352499834910341],
									[42.61903],
									[247.815, 89.600204, 357.7809],
								],
							],
							[
								[2, "17W8jODM2QIAlKvqyzY9yg"],
								null,
								[
									[null, null, 48.85265596917053, 2.3525639861908334],
									[42.425285],
									[64.340416, 89.09827, 356.8697],
								],
							],
							[
								[2, "4SxJs_ajpCD2QXmIYyGkIQ"],
								null,
								[
									[null, null, 48.852750526423755, 2.3523754277783837],
									[41.866413],
									[246.88654, 89.5792, 355.77344],
								],
							],
							[
								[2, "5vWCl8sV2VkCL-d-S6n8CA"],
								null,
								[
									[null, null, 48.8528619739005, 2.3528514821192212],
									[42.948315],
									[240.44067, 87.91107, 357.02258],
								],
							],
							[
								[2, "7-duI1wAfy62lIcKtJC3Dw"],
								null,
								[
									[null, null, 48.852766481993235, 2.3529010255905263],
									[43.65222],
									[66.80371, 92.24497, 353.35733],
								],
							],
							[
								[2, "7gkigBbbwKslo1edjLu02Q"],
								null,
								[
									[null, null, 48.852719247139625, 2.352779954705655],
									[43.60223],
									[54.557392, 87.55007, 354.40308],
								],
							],
							[
								[2, "8-CvQwICxsKI7txH_Be5PQ"],
								null,
								[
									[null, null, 48.852611892016526, 2.352382115639506],
									[41.632015],
									[60.50293, 87.688805, 354.92422],
								],
							],
							[
								[2, "AssHZS4piW2lyIFai156cw"],
								null,
								[
									[null, null, 48.8526346190582, 2.35247319360526],
									[42.360764],
									[69.0176, 89.22591, 355.59552],
								],
							],
							[
								[2, "BEva61WztFBSG9elxti3Yg"],
								null,
								[
									[null, null, 48.85288303622392, 2.35293753545782],
									[42.889996],
									[244.15866, 89.43322, 357.51572],
								],
							],
							[
								[2, "igfe4uvBAwjvntiuPAroQg"],
								null,
								[
									[null, null, 48.85278497525051, 2.3529887525543316],
									[43.070816],
									[63.07233, 92.76524, 356.84412],
								],
							],
							[
								[2, "sx555B7sTwcv_1VfIcUEDQ"],
								null,
								[
									[null, null, 48.852822083388844, 2.3527130095696807],
									[42.985332],
									[240.39099, 90.70531, 356.84308],
								],
							],
							[
								[2, "GmTkafOqWrDkMsDYzy003g"],
								null,
								[
									[null, null, 48.852809874662874, 2.3526523911407344],
									[43.068222],
									[245.70271, 89.06636, 357.79114],
								],
							],
							[
								[2, "ewv6cgTZPvy_6Q93EZmD4Q"],
								null,
								[
									[null, null, 48.852796386641124, 2.3525904660704686],
									[43.009514],
									[241.65356, 88.572235, 356.8257],
								],
							],
							[
								[10, "CIABIhDm2-Qn_cfmFRipbR8i9yV1"],
								null,
								[
									[null, null, 48.852760316241785, 2.3526228099770186],
									[28.625408, null, 73.190704],
									[302.826, 88.55477, 359.8736],
								],
							],
						],
					],
					null,
					null,
					[
						[13, [null, null, null, 73.67899]],
						[1, [null, null, null, 162.72424]],
						[14, [null, null, null, 249.50783]],
					],
					null,
					[[15, [2024, 10], null, null, null, 2]],
				],
			],
			[3, 4, 1, [1], null, [null, null, "scout", [6]], null, [2014, 4]],
			[
				"https://www.google.com/local/imagery/report/?cb_client=apiv3&image_key=!1e2!2s20C-1_sANr4OMdhTDM2N-g",
			],
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			["GEO_PHOTO_REFERENCE", "IMAGE_ALLEYCAT|20C-1_sANr4OMdhTDM2N-g", "1"],
		],
	],
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any;

// alleycat (scout source, no time history)
export const BIN_SCOUT =
	"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";
export const JSON_SCOUT = [
	[0],
	[
		[
			[1],
			[2, "sx555B7sTwcv_1VfIcUEDQ"],
			[
				2,
				2,
				[6656, 13312],
				[
					[
						[[208, 416]],
						[[416, 832]],
						[[832, 1664]],
						[[1664, 3328]],
						[[3328, 6656]],
						[[6656, 13312]],
					],
					[512, 512],
				],
				null,
				null,
				null,
				null,
				null,
				"sx555B7sTwcv_1VfIcUEDQ",
			],
			[],
			[[[["© 2026 Google"]]]],
			[
				[
					[1],
					[
						[null, null, 48.852822083388844, 2.3527130095696807],
						[42.985332, null, 87.55058],
						[240.39099, 90.70531, 356.84308],
					],
					null,
					[
						[
							[
								[2, "sx555B7sTwcv_1VfIcUEDQ"],
								null,
								[
									[null, null, 48.852822083388844, 2.3527130095696807],
									[42.985332],
									[240.39099, 90.70531, 356.84308],
								],
							],
							[
								[2, "7gkigBbbwKslo1edjLu02Q"],
								null,
								[
									[null, null, 48.852719247139625, 2.352779954705655],
									[43.60223],
									[54.557392, 87.55007, 354.40308],
								],
							],
							[
								[2, "-jSCx1MhOeVP64yA7x7SAQ"],
								null,
								[
									[null, null, 48.85277595499152, 2.352499834910341],
									[42.61903],
									[247.815, 89.600204, 357.7809],
								],
							],
							[
								[2, "-kZ6qFzFaIGE0GSIYVGudQ"],
								null,
								[
									[null, null, 48.85281124512541, 2.353075580960707],
									[42.923843],
									[39.65111, 91.823166, 353.82007],
								],
							],
							[
								[2, "17W8jODM2QIAlKvqyzY9yg"],
								null,
								[
									[null, null, 48.85265596917053, 2.3525639861908334],
									[42.425285],
									[64.340416, 89.09827, 356.8697],
								],
							],
							[
								[2, "20C-1_sANr4OMdhTDM2N-g"],
								null,
								[
									[null, null, 48.85280369273168, 2.3526202316161253],
									[43.095886],
									[248.18436, 87.66303, 355.58524],
								],
							],
							[
								[2, "4SxJs_ajpCD2QXmIYyGkIQ"],
								null,
								[
									[null, null, 48.852750526423755, 2.3523754277783837],
									[41.866413],
									[246.88654, 89.5792, 355.77344],
								],
							],
							[
								[2, "5vWCl8sV2VkCL-d-S6n8CA"],
								null,
								[
									[null, null, 48.8528619739005, 2.3528514821192212],
									[42.948315],
									[240.44067, 87.91107, 357.02258],
								],
							],
							[
								[2, "7-duI1wAfy62lIcKtJC3Dw"],
								null,
								[
									[null, null, 48.852766481993235, 2.3529010255905263],
									[43.65222],
									[66.80371, 92.24497, 353.35733],
								],
							],
							[
								[2, "8-CvQwICxsKI7txH_Be5PQ"],
								null,
								[
									[null, null, 48.852611892016526, 2.352382115639506],
									[41.632015],
									[60.50293, 87.688805, 354.92422],
								],
							],
							[
								[2, "8sFEW2YCeyqQ4phKLmW_QA"],
								null,
								[
									[null, null, 48.85267806516653, 2.35264832288659],
									[43.210815],
									[60.32235, 89.20517, 356.57697],
								],
							],
							[
								[2, "AssHZS4piW2lyIFai156cw"],
								null,
								[
									[null, null, 48.8526346190582, 2.35247319360526],
									[42.360764],
									[69.0176, 89.22591, 355.59552],
								],
							],
							[
								[2, "BEva61WztFBSG9elxti3Yg"],
								null,
								[
									[null, null, 48.85288303622392, 2.35293753545782],
									[42.889996],
									[244.15866, 89.43322, 357.51572],
								],
							],
							[
								[2, "CjuqhkoIGmD1F4mVLSiaQQ"],
								null,
								[
									[null, null, 48.852868806942666, 2.3530591707753246],
									[42.040833],
									[332.76547, 90.714615, 356.61896],
								],
							],
							[
								[2, "igfe4uvBAwjvntiuPAroQg"],
								null,
								[
									[null, null, 48.85278497525051, 2.3529887525543316],
									[43.070816],
									[63.07233, 92.76524, 356.84412],
								],
							],
							[
								[2, "dyROSBWTjeHax0NovT8GFg"],
								null,
								[
									[null, null, 48.852714120979755, 2.3532807374040954],
									[39.879593],
									[352.84357, 85.24248, 349.01382],
								],
							],
							[
								[2, "xJBJBH1CD7YQOvdW_-FEpw"],
								null,
								[
									[null, null, 48.85283182598473, 2.3527400612996128],
									[43.04912],
									[240.67792, 90.2145, 357.23184],
								],
							],
							[
								[2, "jHRBt5mqAZyE_BQSPYAEjQ"],
								null,
								[
									[null, null, 48.8528153036669, 2.3526838021552905],
									[42.96559],
									[254.93909, 90.22968, 357.36627],
								],
							],
						],
					],
					null,
					null,
					[
						[1, [null, null, null, 156.82365]],
						[16, [null, null, null, 61.19036]],
						[17, [null, null, null, 250.64696]],
					],
				],
			],
			[3, 2, 1, [1], null, [null, null, "scout", [6]], null, [2014, 4]],
			[
				"https://www.google.com/local/imagery/report/?cb_client=apiv3&image_key=!1e2!2ssx555B7sTwcv_1VfIcUEDQ",
			],
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			["GEO_PHOTO_REFERENCE", "IMAGE_ALLEYCAT|sx555B7sTwcv_1VfIcUEDQ", "1"],
		],
	],
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any;

// nonexistent pano id (envelope status 3)
export const BIN_DEAD = "CgIIAw==";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const JSON_DEAD = [[3]] as any;
