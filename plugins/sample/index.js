// sample/src/index.ts
var { registerPlugin, getMapState, on } = MMA;
registerPlugin({
  activate() {
    const map = getMapState().map;
    if (map) {
      console.log(`[sample] Activated on "${map.name}"`);
    }
    const unsub = on("location:add", (locations) => {
      console.log(`[sample] ${locations.length} location(s) added`);
    });
    return () => {
      unsub();
    };
  }
});
