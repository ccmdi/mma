# Bundled data

Both files are compiled into the binary with `include_bytes!`/`include_str!`, so they are
always available offline and cost no startup parsing beyond a header read.

## `cities.bin`

Packed reverse-geocoding table: 144,563 populated places with their nearest-city name,
first-level administrative division, and ISO 3166-1 alpha-2 country code. Points are stored
in implicit kd-tree order, so the spatial index costs no bytes at all -- the array order is
the tree. Built by `scripts/gen-cities-bin.mjs`; see `src/net/geocoder.rs` for the layout
and the descent.

Derived from the **GeoNames** cities1000 dataset (<https://www.geonames.org/>), which is
licensed **CC BY 4.0**. Attribution is required for redistribution. The dataset reaches us
via the `reverse_geocoder` crate, which is kept as a dev-dependency so
`src/net/geocoder.test.rs` can use its kd-tree as a differential oracle.

## `borders.json`

Country boundary polygons at the "light" detail level, the offline fallback for the
borders plugin. The heavier `medium`/`heavy`/`adm1` levels are downloaded on demand to the
app data dir and memory-mapped instead of being bundled.
