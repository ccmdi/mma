// copyright/src/index.ts
var { registerPlugin, registerEnrichFields, registerProvider } = MMA;
var FIELD_DEFS = {
  // Year labels are identification categories, not distances: comparison stays
  // categorical (disambiguate) while type=number keeps numeric bucketing/ranges.
  copyrightYear: {
    type: "number",
    label: "Copyright year",
    values: null,
    labels: null,
    comparison: { type: "categorical" }
  }
};
registerPlugin({
  activate() {
    registerEnrichFields([
      { key: "copyrightYear", label: "Copyright year" }
    ]);
    registerProvider({
      id: "copyright",
      label: "Copyright year",
      requires: ["panoId"],
      fieldDefs: FIELD_DEFS,
      procedure: {
        entry: "procedure.js",
        // The resident sidecar answers each chunk with one reply, so pages stay
        // small enough to fit the transport budget and keep progress moving.
        batch: { mode: "chunk", size: 1e3 },
        instances: 1
      }
    });
  },
  comingSoon: true
});
