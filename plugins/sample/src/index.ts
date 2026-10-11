// Identity (id, name, description, icon) comes from manifest.json.
// This file only provides behavior.

const { registerPlugin, getMapState, on } = MMA;

registerPlugin({
  activate() {
    const map = getMapState().map;
    if (map) {
      console.log(`[sample] Activated on "${map.name}"`);
    }

    // Subscribe to events
    const unsub = on("store:change", (change) => {
      console.log(`[sample] change: +${change.added.length} -${change.removed.length}`);
    });

    // Read/write location extra fields
    // const loc = MMA.getMapState().open?.location;
    // if (loc) {
    //   MMA.updateLocations([{ id: loc.id, extra: { myField: "hello from plugin" } }]);
    // }

    // Spawn a subprocess
    // const cmd = MMA.shell.Command.create("python", ["./script.py"]);
    // cmd.stdout.on("data", (line) => console.log(line));
    // cmd.spawn();

    // File dialogs
    // const path = await MMA.dialog.open({ filters: [{ name: "JSON", extensions: ["json"] }] });

    // Cleanup — called on deactivate
    return () => {
      unsub();
    };
  },
});
