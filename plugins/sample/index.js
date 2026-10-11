// sample/src/index.ts
var { registerPlugin, Store, on } = MMA;
registerPlugin({
  activate() {
    const map = Store.get().map;
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
