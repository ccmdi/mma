// sample/src/index.ts
MMA.registerPlugin({
  activate() {
    const map = MMA.getMapState().map;
    if (map) {
      console.log(`[sample] Activated on "${map.name}"`);
    }
    const unsub = MMA.on("location:add", (locations) => {
      console.log(`[sample] ${locations.length} location(s) added`);
    });
    return () => {
      unsub();
    };
  }
});
