// Drives the built bundle directly: `run` and `query` against a scripted GetMetadata
// stub, with request bytes pinned against the app's generated writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PbfReader, PbfWriter } from "pbf";
import {
  readGetMetadataRequest,
  writeGetMetadataRequest,
  writeGetMetadataResponse,
} from "../../../src/lib/proto/getmetadata.gen.js";

const { run, query, configure } = await import(
  new URL("../../../src-tauri/procedures/svMeta.js", import.meta.url).href
);

// --- Reference request bytes, via the app's generated writer ---

const OFFICIAL_PANO_RE = /^[-_A-Za-z0-9]{21}[AQgw]$/;

/** Port of panoIdToImageKey (app/src/lib/sv/panoId.ts). */
function panoIdToImageKey(panoId) {
  if (panoId.startsWith("F:")) return [3, panoId.slice(2)];
  if (!panoId.startsWith("F:") && OFFICIAL_PANO_RE.test(panoId)) return [2, panoId];
  try {
    const b64 = panoId.replace(/\.+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pbf = new PbfReader(bytes);
    let type = 2;
    let id = panoId;
    let field;
    while ((field = pbf.nextField())) {
      if (field === 1) type = pbf.readVarint();
      else if (field === 2) id = pbf.readString();
      else pbf.skip(pbf.type);
    }
    return [type, id];
  } catch {
    return [2, panoId];
  }
}

function refRequestBytes(panoIds) {
  const req = {
    context: { productId: "apiv3", language: "en" },
    locale: { language: "en", regionCode: "US" },
    key: panoIds.map((id) => {
      const [frontend, keyId] = panoIdToImageKey(id);
      return { key: { frontend, id: keyId } };
    }),
    spec: { component: [1, 2, 3, 4, 8, 6] },
  };
  const w = new PbfWriter();
  writeGetMetadataRequest(req, w);
  return Buffer.from(w.finish());
}

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A pano id that is a base64url-encoded binary ImageKey. */
function binaryPanoId(frontend, id) {
  const w = new PbfWriter();
  w.writeVarintField(1, frontend);
  w.writeStringField(2, id);
  return b64url(w.finish());
}

// --- Response builder, via the app's generated writer ---

function responseBytes(obj) {
  const w = new PbfWriter();
  writeGetMetadataResponse(obj, w);
  return Buffer.from(w.finish());
}

const EMPTY_RESPONSE = responseBytes({ metadata: [] });

/** ImageMetadata for a happy pano, with per-case overrides. */
function meta(over = {}) {
  const info = {
    location: {
      location: { lat: 35.6, lng: 139.7 },
      altitude: { meters: 12.5 },
      pov: { heading: 123.5 },
      countryCode: "JP",
      ...(over.level ? { level: over.level } : {}),
    },
    time: over.time ?? [],
  };
  return {
    status: { code: over.statusCode ?? 1 },
    pano: { frontend: over.frontend ?? 2, id: over.panoId ?? "x" },
    tiles: { worldSize: { height: over.height ?? 6656, width: 13312 } },
    attribution: { author: [{ name: { text: over.uploader ?? "Some Uploader" } }] },
    information: [info],
    date: {
      sourceInfo: { source: over.source ?? "launch" },
      date: over.date ?? { year: 2021, month: 6, day: 15 },
    },
  };
}

// --- Harness ---

const EMPTY_ROW = {
  lat: 0,
  lng: 0,
  heading: 0,
  pitch: 0,
  zoom: 0,
  flags: 0,
  createdAt: 0,
  modifiedAt: null,
  panoId: null,
  tags: [],
  extra: null,
};

/** Installs an `mma` global answering GetMetadata through `respond`, which receives
 *  {n, keys, bytes} and returns response bytes or {status, body}. */
function install(respond, { abortAfter = Infinity, fields = null } = {}) {
  const calls = [];
  const failed = [];
  let hostCalls = 0;
  let progress = 0;

  /** Records one request and returns the scripted {status, body} for it. */
  const answer = (req) => {
    const bytes = Buffer.from(req.body);
    const decoded = readGetMetadataRequest(new PbfReader(new Uint8Array(bytes)));
    const call = {
      req,
      bytes,
      decoded,
      keys: decoded.key.map((k) => `${k.key.frontend}:${k.key.id}`),
      n: calls.length,
    };
    calls.push(call);
    const r = respond(call);
    const status = r && r.status !== undefined ? r.status : 200;
    const body = (r && r.status !== undefined ? r.body : r) ?? Buffer.alloc(0);
    return { status, body: new Uint8Array(body) };
  };

  globalThis.mma = {
    fetch: answer,
    fetchMany(reqs) {
      hostCalls++;
      return reqs.map(answer);
    },
    log() {},
    progress(units) {
      progress += units;
    },
    fail(id) {
      failed.push(id);
    },
    aborted: () => calls.length >= abortAfter,
  };
  configure(fields ? { fields, force: false, config: null } : null);
  return { calls, state: () => ({ progress, failed, hostCalls }) };
}

/** Runs `run` over `rows`. This procedure writes `extra` only; unwrap so the cases
 *  below read the fields. */
function runProcedure(rows, respond, opts = {}) {
  const h = install(respond, opts);
  const patches = run(rows.map((r) => ({ ...EMPTY_ROW, ...r }))).map((p) => {
    assert.deepEqual(Object.keys(p.patch), ["extra"], "patch entries must be LocationPatch-shaped");
    return { id: p.id, patch: p.patch.extra };
  });
  return { patches, calls: h.calls, ...h.state() };
}

/** Runs `query` and puts its answer through the JSON the host serializes it to. */
function queryProcedure(input, respond, opts = {}) {
  const h = install(respond, opts);
  const result = JSON.parse(JSON.stringify(query(input)));
  return { result, calls: h.calls, ...h.state() };
}

const CLASSIC_A = "abcdefghijklmnopqrstuA";
const CLASSIC_B = "vwxyz0123456789-_ABCDQ";
const FIFE = "F:AF1QipMabcdefgHIJklmn";
const BINARY = binaryPanoId(10, "user-upload-1234");

/** One row per pano, ids 1..n. */
const rowsFor = (panoIds, extra = null) =>
  panoIds.map((panoId, i) => ({ id: i + 1, lat: 1, lng: 2, panoId, extra }));

// --- Request bytes ---

test("request bytes are byte-identical to the generated writer", () => {
  const cases = [
    ["two classic panos", [CLASSIC_A, CLASSIC_B]],
    ["F:-prefixed pano", [FIFE]],
    ["base64url binary key", [BINARY]],
    ["mixed", [CLASSIC_A, FIFE, BINARY]],
  ];
  for (const [label, panoIds] of cases) {
    const { calls } = runProcedure(rowsFor(panoIds), () => EMPTY_RESPONSE);
    assert.equal(calls.length >= 1, true, `${label}: fetched`);
    assert.deepEqual(
      [...calls[0].bytes],
      [...refRequestBytes(panoIds)],
      `${label}: request bytes match`,
    );
  }
});

test("the binary key decodes to its inner frontend and id", () => {
  const { calls } = runProcedure(rowsFor([BINARY]), () => EMPTY_RESPONSE);
  assert.deepEqual(calls[0].keys, ["10:user-upload-1234"]);
});

test("an undecodable pano id falls back to an official key", () => {
  const { calls } = runProcedure(rowsFor(["not valid base64 !!"]), () => EMPTY_RESPONSE);
  assert.deepEqual(calls[0].keys, ["2:not valid base64 !!"]);
});

// --- Decode ---

test("a full row yields all eight fields with sorted coverage dates", () => {
  const { patches, progress, failed } = runProcedure(rowsFor([CLASSIC_A]), () =>
    responseBytes({
      status: { code: 0 },
      metadata: [
        meta({
          time: [
            { target: 1, date: { year: 2019, month: 5, day: 1 } },
            { target: 2, date: { year: 2015, month: 8, day: 1 } },
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(failed, []);
  assert.equal(progress, 1);
  assert.deepEqual(patches[0].patch, {
    altitude: 12.5,
    countryCode: "JP",
    cameraType: "gen2",
    panoType: 2,
    drivingDirection: 123.5,
    uploaderName: "Some Uploader",
    imageDate: "2021-06",
    coverageDates: ["2015-08", "2019-05", "2021-06"],
  });
  // Key order mirrors buildPatch's object literal.
  assert.equal(
    Object.keys(patches[0].patch).join(","),
    "altitude,countryCode,cameraType,panoType,drivingDirection,uploaderName,imageDate,coverageDates",
  );
});

test("coverage dates are the protobuf civil months, ascending", () => {
  const times = [
    { target: 1, date: { year: 2019, month: 5, day: 1 } },
    { target: 2, date: { year: 2015, month: 12, day: 31 } },
    // 0 is the protobuf default for both, i.e. year only.
    { target: 3, date: { year: 2016, month: 0, day: 0 } },
    // No date at all: not a capture the history can place.
    { target: 4 },
  ];
  const { patches } = runProcedure(rowsFor([CLASSIC_A]), () =>
    responseBytes({ metadata: [meta({ time: times, date: { year: 2021, month: 6, day: 15 } })] }),
  );
  assert.deepEqual(patches[0].patch.coverageDates, [
    "2015-12",
    "2016-01",
    "2019-05",
    "2021-06",
  ]);
});

test("missing optional fields collapse to nulls and defaults", () => {
  const { patches, failed } = runProcedure(rowsFor([CLASSIC_A]), () =>
    responseBytes({ metadata: [{ status: { code: 1 }, information: [{}] }] }),
  );
  assert.deepEqual(failed, []);
  assert.deepEqual(patches[0].patch, {
    altitude: 0,
    countryCode: null,
    cameraType: null,
    panoType: 2,
    drivingDirection: null,
    uploaderName: null,
    imageDate: null,
    coverageDates: [],
  });
});

test("a non-OK image status produces no patch and no failure", () => {
  const { patches, progress, failed } = runProcedure(rowsFor([CLASSIC_A, CLASSIC_B]), () =>
    responseBytes({ metadata: [meta(), meta({ statusCode: 2 })] }),
  );
  assert.deepEqual(
    patches.map((p) => p.id),
    [1],
  );
  assert.deepEqual(failed, []);
  assert.equal(progress, 2);
});

test("metadata with no information entry is null", () => {
  const { patches } = runProcedure(rowsFor([CLASSIC_A]), () =>
    responseBytes({ metadata: [{ status: { code: 1 } }] }),
  );
  assert.deepEqual(patches, []);
});

test("top-level status 5 nulls the whole request", () => {
  const { patches, calls, progress } = runProcedure(rowsFor([CLASSIC_A]), () =>
    responseBytes({ status: { code: 5 }, metadata: [meta()] }),
  );
  assert.deepEqual(patches, []);
  assert.equal(calls.length, 1);
  assert.equal(progress, 1);
});

test("top-level status 3 bisects a multi-pano request", () => {
  const panos = [CLASSIC_A, CLASSIC_B];
  const { calls } = runProcedure(rowsFor(panos), (c) =>
    c.n === 0
      ? responseBytes({ status: { code: 3 }, metadata: [] })
      : responseBytes({ metadata: [meta()] }),
  );
  assert.deepEqual(
    calls.map((c) => c.keys.length),
    [2, 1, 1],
  );
});

test("an all-null request is bisected until results come back", () => {
  const panos = [CLASSIC_A, CLASSIC_B, FIFE, BINARY];
  const { patches, calls, progress, failed } = runProcedure(rowsFor(panos), (c) =>
    c.keys.length === 4 ? EMPTY_RESPONSE : responseBytes({ metadata: c.keys.map(() => meta()) }),
  );
  assert.deepEqual(
    calls.map((c) => c.keys.length),
    [4, 2, 2],
  );
  assert.deepEqual(calls[1].decoded.key.map((k) => k.key.id).length, 2);
  assert.deepEqual(
    patches.map((p) => p.id),
    [1, 2, 3, 4],
  );
  assert.deepEqual(failed, []);
  assert.equal(progress, 4);
});

test("a single-pano all-null response is not bisected", () => {
  const { calls, patches } = runProcedure(rowsFor([CLASSIC_A]), () => EMPTY_RESPONSE);
  assert.equal(calls.length, 1);
  assert.deepEqual(patches, []);
});

test("a non-2xx response is split, not written off whole", () => {
  const rows = [
    { id: 1, panoId: CLASSIC_A },
    { id: 2, panoId: CLASSIC_B },
    { id: 3, panoId: CLASSIC_A },
  ];
  const { patches, failed, progress, calls } = runProcedure(rows, () => ({
    status: 500,
    body: Buffer.alloc(0),
  }));
  // The pair goes out together, then once each after the split.
  assert.equal(calls.length, 3);
  assert.deepEqual(patches, []);
  assert.deepEqual([...failed].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(progress, 3);
});

test("a failed request isolates to the pano that caused it", () => {
  const panos = [CLASSIC_A, CLASSIC_B, FIFE, BINARY];
  const poisoned = (keys) => keys.some((k) => k.endsWith(CLASSIC_B));
  const { patches, failed } = runProcedure(rowsFor(panos), (c) =>
    poisoned(c.keys) ? { status: 500, body: Buffer.alloc(0) } : responseBytes({ metadata: c.keys.map(() => meta()) }),
  );
  // Only the poison pano ends up failed; its neighbours still resolve.
  assert.deepEqual(failed, [2]);
  assert.deepEqual(
    patches.map((p) => p.id),
    [1, 3, 4],
  );
});

/** 22-char official-looking pano ids, distinct per index. */
const manyPanos = (n) =>
  Array.from({ length: n }, (_, i) => `pano${String(i).padStart(6, "0")}`.padEnd(21, "x") + "A");

test("every request of a round is issued in one host call", () => {
  const panos = manyPanos(450);
  const { calls, hostCalls, patches } = runProcedure(rowsFor(panos), (c) =>
    responseBytes({ metadata: c.keys.map(() => meta()) }),
  );
  // 450 panos is three requests at GetMetadata's 200 cap, handed over together: the
  // module asks for everything at once and the host decides how much runs in parallel.
  assert.deepEqual(
    calls.map((c) => c.keys.length),
    [200, 200, 50],
  );
  assert.equal(hostCalls, 1);
  assert.equal(patches.length, 450);
});

test("a bisected round retries both halves in one host call", () => {
  const panos = manyPanos(4);
  const { calls, hostCalls } = runProcedure(rowsFor(panos), (c) =>
    c.keys.length === 4 ? EMPTY_RESPONSE : responseBytes({ metadata: c.keys.map(() => meta()) }),
  );
  assert.deepEqual(
    calls.map((c) => c.keys.length),
    [4, 2, 2],
  );
  // One call for the round that came back empty, one for the two halves together.
  assert.equal(hostCalls, 2);
});

// --- Dedupe and skips ---

test("rows sharing a pano are fetched once and fanned out", () => {
  const rows = [
    { id: 7, panoId: CLASSIC_A },
    { id: 8, panoId: CLASSIC_A },
    { id: 9, panoId: CLASSIC_B },
  ];
  const { patches, calls, progress } = runProcedure(rows, (c) =>
    responseBytes({ metadata: c.keys.map(() => meta()) }),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].keys.length, 2);
  assert.deepEqual(
    patches.map((p) => p.id),
    [7, 8, 9],
  );
  assert.equal(progress, 3);
});

test("rows without a pano id are skipped entirely", () => {
  const rows = [
    { id: 1, panoId: "" },
    { id: 2, panoId: CLASSIC_A },
  ];
  const { patches, calls, progress, failed } = runProcedure(rows, () =>
    responseBytes({ metadata: [meta()] }),
  );
  assert.deepEqual(calls[0].keys.length, 1);
  assert.deepEqual(
    patches.map((p) => p.id),
    [2],
  );
  assert.equal(progress, 1);
  assert.deepEqual(failed, []);
});

test("no rows with panos means no requests at all", () => {
  const { patches, calls, progress } = runProcedure([{ id: 1, panoId: "" }], () => {
    throw new Error("must not fetch");
  });
  assert.deepEqual(patches, []);
  assert.equal(calls.length, 0);
  assert.equal(progress, 0);
});

// --- Staleness ---

const stale = (extra) =>
  runProcedure(rowsFor([CLASSIC_A], extra), () => responseBytes({ metadata: [meta()] }));

test("a changed imageDate nulls datetime and timezone", () => {
  const { patches } = stale({ imageDate: "2020-01", datetime: 1600000000 });
  assert.equal(patches[0].patch.datetime, null);
  assert.equal(patches[0].patch.timezone, null);
  assert.equal("datetime" in patches[0].patch, true);
  assert.equal("timezone" in patches[0].patch, true);
});

test("an unchanged imageDate leaves datetime alone", () => {
  const { patches } = stale({ imageDate: "2021-06", datetime: 1600000000 });
  assert.equal("datetime" in patches[0].patch, false);
  assert.equal("timezone" in patches[0].patch, false);
});

test("no existing datetime means no staleness keys", () => {
  const { patches } = stale({ imageDate: "2020-01" });
  assert.equal("datetime" in patches[0].patch, false);
});

test("a null datetime means no staleness keys", () => {
  const { patches } = stale({ imageDate: "2020-01", datetime: null });
  assert.equal("datetime" in patches[0].patch, false);
});

test("an absent imageDate counts as changed", () => {
  const { patches } = stale({ datetime: 1600000000 });
  assert.equal(patches[0].patch.datetime, null);
  assert.equal(patches[0].patch.timezone, null);
});

test("a row with no extra never adds staleness keys", () => {
  const { patches } = stale(null);
  assert.equal("datetime" in patches[0].patch, false);
});

// --- Camera type ---

test("camera type known answers", () => {
  const cases = [
    ["gen1 height", { height: 1664 }, "gen1"],
    ["gen2 height", { height: 6656 }, "gen2"],
    ["gen4 height", { height: 8192 }, "gen4"],
    ["unknown height", { height: 9999 }, null],
    ["gen4 + scout", { height: 8192, source: "scout" }, "trekker"],
    ["gen1 + scout stays gen1", { height: 1664, source: "scout" }, "gen1"],
    ["gen2 + scout", { height: 6656, source: "scout" }, "trekker"],
    ["gen2 + level", { height: 6656, level: { id: 1 } }, "tripod"],
    ["gen2 + level, no id", { height: 6656, level: {} }, "tripod"],
    ["gen2 + scout + level prefers tripod", { height: 6656, source: "scout", level: { id: 1 } }, "tripod"],
  ];
  for (const [label, over, expected] of cases) {
    const { patches } = runProcedure(rowsFor([CLASSIC_A]), () =>
      responseBytes({ metadata: [meta(over)] }),
    );
    assert.equal(patches[0].patch.cameraType, expected, label);
  }
});

test("badcam thresholds", () => {
  const cases = [
    ["GB after 2021-01", "GB", { year: 2021, month: 6 }, 51, "badcam"],
    ["GB before 2021-01", "GB", { year: 2020, month: 6 }, 51, "gen2"],
    ["US above 52N after 2019-01", "US", { year: 2020, month: 1 }, 60, "badcam"],
    ["US below 52N", "US", { year: 2020, month: 1 }, 40, "gen2"],
    ["CY always", "CY", { year: 2005, month: 1 }, 35, "badcam"],
    ["JP never", "JP", { year: 2023, month: 1 }, 35, "gen2"],
    ["no date is not badcam", "GB", undefined, 51, "gen2"],
  ];
  for (const [label, cc, date, lat, expected] of cases) {
    const m = meta({ height: 6656, date: date ?? { year: 0, month: 0, day: 0 } });
    m.information[0].location.countryCode = cc;
    m.information[0].location.location = { lat, lng: 0 };
    const { patches } = runProcedure(rowsFor([CLASSIC_A]), () =>
      responseBytes({ metadata: [m] }),
    );
    assert.equal(patches[0].patch.cameraType, expected, label);
  }
});

// --- Abort ---

test("abort between sub-chunks stops fetching", () => {
  const panos = [CLASSIC_A, CLASSIC_B, FIFE, BINARY];
  const { calls, patches } = runProcedure(
    rowsFor(panos),
    () => EMPTY_RESPONSE,
    { abortAfter: 1 },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(patches, []);
});

// --- Field selection ---

const configured = (fields, extra) =>
  runProcedure(rowsFor([CLASSIC_A], extra), () => responseBytes({ metadata: [meta()] }), {
    fields,
  });

test("only the configured fields are written", () => {
  const { patches } = configured(["countryCode", "imageDate", "notAField"]);
  assert.deepEqual(Object.keys(patches[0].patch), ["countryCode", "imageDate"]);
});

test("staleness nulls bypass field selection", () => {
  const extra = { imageDate: "2020-01", datetime: 1600000000 };
  const { patches } = configured(["countryCode"], extra);
  assert.deepEqual(patches[0].patch, {
    countryCode: "JP",
    datetime: null,
    timezone: null,
  });
});

test("a fully deselected provider still writes the staleness nulls", () => {
  const extra = { imageDate: "2020-01", datetime: 1600000000 };
  const { patches } = configured([], extra);
  assert.deepEqual(patches[0].patch, { datetime: null, timezone: null });
});

test("a fully deselected provider with nothing stale writes nothing", () => {
  const { patches } = configured([], { imageDate: "2021-06" });
  assert.deepEqual(patches, []);
});

// --- query ---

/** The full metadata a query can decode, including everything `run` never reads. */
function richMeta(over = {}) {
  const base = meta(over);
  return {
    ...base,
    tiles: { worldSize: { height: 8192, width: 16384 }, tileSize: { tileSize: { height: 512, width: 512 } } },
    description: { description: [{ text: "Main Street" }, { text: "Springfield" }] },
    attribution: {
      item: [{ name: { name: "© 2021 Google" } }],
      author: [{ name: { text: "Some Uploader" } }],
    },
    information: [
      {
        ...base.information[0],
        relations: { pano: [{ key: { frontend: 2, id: CLASSIC_B } }, { key: { frontend: 3, id: "AF1Qz" } }] },
        link: [
          { target: 0, properties: { heading: 90 } },
          { target: 1, properties: { heading: 270 } },
        ],
        time: [{ target: 0, date: { year: 2019, month: 5, day: 1 } }],
      },
    ],
  };
}

test("query metadata answers the full pano shape", () => {
  const { result, calls } = queryProcedure({ op: "metadata", panoIds: [CLASSIC_A] }, () =>
    responseBytes({ metadata: [richMeta({ panoId: CLASSIC_A })] }),
  );
  assert.equal(calls.length, 1);
  // The decoded image as it stands: flat, nothing derived. Camera type, image date and
  // coverage dates are functions over this on the app side.
  assert.deepEqual(result, [
    {
      pano: CLASSIC_A,
      panoFrontend: 2,
      worldSize: { width: 16384, height: 8192 },
      tileSize: { width: 512, height: 512 },
      copyright: "© 2021 Google",
      description: "Main Street, Springfield",
      // The Maps JS API takes the short description from the first part alone.
      shortDescription: "Main Street",
      uploaderName: "Some Uploader",
      lat: 35.6,
      lng: 139.7,
      altitude: 12.5,
      pov: { heading: 123.5, tilt: 0, roll: 0 },
      countryCode: "JP",
      levelId: null,
      links: [
        { pano: CLASSIC_B, heading: 90 },
        { pano: "F:AF1Qz", heading: 270 },
      ],
      // The timeline appends the image's own capture and sorts ascending; the month is
      // the protobuf month, undecremented.
      time: [
        { pano: CLASSIC_B, date: "2019-05-01" },
        { pano: CLASSIC_A, date: "2021-06-15" },
      ],
      date: { year: 2021, month: 6, day: 15 },
      source: "launch",
    },
  ]);
});

test("query metadata collapses absent submessages to nulls and zeroes", () => {
  const { result } = queryProcedure({ op: "metadata", panoIds: [CLASSIC_A] }, () =>
    responseBytes({ metadata: [{ status: { code: 1 }, information: [{}] }] }),
  );
  assert.deepEqual(result, [
    {
      pano: "",
      panoFrontend: 2,
      worldSize: { width: 0, height: 0 },
      tileSize: { width: 0, height: 0 },
      copyright: "",
      description: "",
      shortDescription: "",
      uploaderName: null,
      lat: 0,
      lng: 0,
      altitude: 0,
      pov: null,
      countryCode: null,
      levelId: null,
      links: [],
      time: [],
      date: null,
      source: null,
    },
  ]);
});

test("query metadata reports a level id", () => {
  const { result } = queryProcedure({ op: "metadata", panoIds: [CLASSIC_A] }, () =>
    responseBytes({ metadata: [meta({ level: { id: 4 } })] }),
  );
  assert.equal(result[0].levelId, 4);
});

test("query metadata keeps results aligned and dedupes the fetch", () => {
  const { result, calls } = queryProcedure(
    { op: "metadata", panoIds: [CLASSIC_A, "", CLASSIC_A, CLASSIC_B] },
    (c) => responseBytes({ metadata: c.keys.map((k) => meta({ panoId: k.split(":")[1] })) }),
  );
  assert.deepEqual(calls[0].keys, [`2:${CLASSIC_A}`, `2:${CLASSIC_B}`]);
  assert.equal(result.length, 4);
  assert.equal(result[0].pano, CLASSIC_A);
  assert.equal(result[1], null);
  assert.equal(result[2].pano, CLASSIC_A);
  assert.equal(result[3].pano, CLASSIC_B);
});

test("query metadata answers null for a failed request", () => {
  const { result } = queryProcedure({ op: "metadata", panoIds: [CLASSIC_A] }, () => ({
    status: 500,
    body: Buffer.alloc(0),
  }));
  assert.deepEqual(result, [null]);
});

test("query rejects an unknown op", () => {
  const { result, calls } = queryProcedure({ op: "nope" }, () => EMPTY_RESPONSE);
  assert.equal(calls.length, 0);
  assert.match(result.error, /unknown query op/);
});
