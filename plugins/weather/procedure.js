// weather/src/procedure.ts
var ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
var MAX_TIME_MS = 864e13;
var HOURLY = [
  ["weatherCode", "weather_code"],
  ["cloudCover", "cloud_cover"],
  ["precipitation", "precipitation"],
  ["snowDepth", "snow_depth"],
  ["snowfall", "snowfall"],
  ["temperature2m", "temperature_2m"],
  ["sunshineDuration", "sunshine_duration"],
  ["windSpeed10m", "wind_speed_10m"]
];
var fields = null;
function configure(cfg) {
  fields = Array.isArray(cfg?.fields) ? new Set(cfg.fields) : null;
}
var enabled = (key) => fields === null || fields.has(key);
var pad2 = (n) => String(n).padStart(2, "0");
function utcParts(secs) {
  const d = new Date(Math.trunc(secs * 1e3));
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return { date, hourKey: `${date}T${pad2(d.getUTCHours())}:00` };
}
function usableSeconds(row) {
  const secs = row.extra?.datetime;
  if (typeof secs !== "number") return null;
  const ms = secs * 1e3;
  if (!isFinite(ms) || Math.abs(ms) > MAX_TIME_MS) return null;
  return secs;
}
function request(rows) {
  const lat = [];
  const lng = [];
  const dates = [];
  for (const row of rows) {
    const secs = usableSeconds(row);
    if (secs === null) continue;
    lat.push(String(row.lat));
    lng.push(String(row.lng));
    dates.push(utcParts(secs).date);
  }
  const hourly = HOURLY.filter(([key]) => enabled(key)).map(([, param]) => param).join(",");
  const joined = dates.join(",");
  return {
    method: "GET",
    url: `${ARCHIVE_URL}?latitude=${lat.join(",")}&longitude=${lng.join(",")}&start_date=${joined}&end_date=${joined}&hourly=${hourly}&timezone=GMT`
  };
}
function parseResults(body) {
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : [parsed];
}
var decoder = new TextDecoder();
function map(rows, response) {
  if (response.status !== 200) {
    for (const row of rows) mma.fail(row.id);
    return [];
  }
  const results = parseResults(decoder.decode(response.body));
  const out = [];
  let pos = 0;
  for (const row of rows) {
    const secs = usableSeconds(row);
    if (secs === null) continue;
    const hourly = results[pos++]?.hourly;
    if (!hourly || !Array.isArray(hourly.time)) continue;
    const idx = hourly.time.indexOf(utcParts(secs).hourKey);
    if (idx < 0) continue;
    const patch = {};
    for (const [key, param] of HOURLY) {
      if (!enabled(key)) continue;
      const series = hourly[param];
      if (!Array.isArray(series) || idx >= series.length) continue;
      const value = series[idx];
      if (value === null || value === void 0) continue;
      patch[key] = value;
    }
    if (Object.keys(patch).length > 0) out.push({ id: row.id, patch: { extra: patch } });
  }
  return out;
}
export {
  configure,
  map,
  request
};
