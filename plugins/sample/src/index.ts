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
    const unsub = on("location:add", (locations) => {
      console.log(`[sample] ${(locations as unknown[]).length} location(s) added`);
    });

    // Read/write location extra fields
    // const loc = MMA.getMapState().activeLocation;
    // if (loc) {
    //   MMA.updateLocation(loc, {
    //     extra: { ...loc.extra, myField: "hello from plugin" },
    //   });
    // }

    // Spawn a subprocess
    // const cmd = MMA.shell.Command.create("python", ["./script.py"]);
    // cmd.stdout.on("data", (line) => console.log(line));
    // cmd.spawn();

    // File dialogs
    // const path = await MMA.dialog.open({ filters: [{ name: "JSON", extensions: ["json"] }] });

    // Raw Tauri IPC
    // const locs = await MMA.invoke("store_get_all_locations");

    // Cleanup — called on deactivate
    return () => {
      unsub();
    };
  },
});
