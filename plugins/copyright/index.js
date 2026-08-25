// copyright/src/index.ts
var FIELD_DEFS = {
  // Year labels are identification categories, not distances: comparison stays
  // categorical (disambiguate) while type=number keeps numeric bucketing/ranges.
  copyrightYear: { type: "number", label: "Copyright year", comparison: { type: "categorical" } }
};
MMA.registerPlugin({
  activate() {
    MMA.registerEnrichFields([
      { key: "copyrightYear", label: "Copyright year" }
    ]);
    MMA.registerEnrichmentProvider({
      id: "copyright",
      label: "Copyright year",
      fieldDefs: FIELD_DEFS,
      procedure: {
        entry: "procedure.js",
        batch: { mode: "chunk", size: 50 },
        // One sidecar process serves the whole run, so batches must not overlap.
        instances: 1
      }
    });
  },
  comingSoon: true
});
