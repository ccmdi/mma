# Border data attribution

`borders-adm1.{json,rkyv}` are derived from the [Overture Maps Foundation](https://overturemaps.org/)
`divisions` theme (release 2026-06-17.0, `division_area`, subtype `region`, land-clipped,
simplified to ~100m tolerance). The dataset is available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/), and these
derived files are likewise offered under ODbL 1.0.

Per [Overture's attribution requirements](https://docs.overturemaps.org/attribution/):

> (c) OpenStreetMap contributors. Available under the Open Database License.
> geoBoundaries (https://www.geoboundaries.org/). Available under CC BY 4.0.
> Esri Community Maps contributors (https://communitymaps.arcgis.com/home/). Available under CC BY 4.0.
> Land Information New Zealand (LINZ) (https://www.linz.govt.nz/). Available under CC BY 4.0.

`borders-medium.{json,rkyv}` and `borders-heavy.{json,rkyv}` are derived from
[geoBoundaries](https://www.geoboundaries.org/) CGAZ ADM0 (the published simplified and
open releases), available under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
and these derived files are likewise offered under CC BY 4.0:

> geoBoundaries (https://www.geoboundaries.org/). Available under CC BY 4.0.

Both are rebuilt from those sources by padding each source polygon seaward, then cutting
it along the bundled light border set, so the three tiers share one taxonomy.
