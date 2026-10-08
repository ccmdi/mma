// sample/src/index.ts
var { registerPlugin, getMapState, on } = MMA;
registerPlugin({
  activate() {
    const map = getMapState().map;
    if (map) {
      console.log(`[sample] Activated on "${map.name}"`);
    }
    const unsub = on("store:change", (change) => {
      console.log(`[sample] change: +${change.added.length} -${change.removed.length}`);
    });
    return () => {
      unsub();
    };
  }
});
