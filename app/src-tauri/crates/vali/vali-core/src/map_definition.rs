use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::collections::HashMap;
use std::fmt;
#[derive(Debug, Clone, Default)]
pub struct OrderedMap(pub Vec<(String, String)>);
impl<'de> Deserialize<'de> for OrderedMap {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = OrderedMap;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a string-to-string object")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<OrderedMap, A::Error> {
                let mut entries = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, String>()? {
                    entries.push((k, v));
                }
                Ok(OrderedMap(entries))
            }
        }
        deserializer.deserialize_map(V)
    }
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MapDefinition {
    #[serde(alias = "CountryCodes")]
    pub country_codes: Vec<String>,
    #[serde(alias = "SubdivisionInclusions")]
    pub subdivision_inclusions: HashMap<String, Vec<String>>,
    #[serde(alias = "SubdivisionExclusions")]
    pub subdivision_exclusions: HashMap<String, Vec<String>>,
    #[serde(alias = "CountryDistribution")]
    pub country_distribution: HashMap<String, i32>,
    #[serde(alias = "SubdivisionDistribution")]
    pub subdivision_distribution: HashMap<String, HashMap<String, i32>>,
    #[serde(alias = "DistributionStrategy")]
    pub distribution_strategy: DistributionStrategy,
    #[serde(alias = "GlobalLocationFilter")]
    pub global_location_filter: Option<String>,
    #[serde(alias = "CountryLocationFilters")]
    pub country_location_filters: HashMap<String, String>,
    #[serde(alias = "SubdivisionLocationFilters")]
    pub subdivision_location_filters: HashMap<String, HashMap<String, String>>,
    #[serde(alias = "NamedExpressions")]
    pub named_expressions: OrderedMap,
    #[serde(alias = "Output")]
    pub output: MapOutput,
    #[serde(alias = "EnableDefaultLocationFilters")]
    pub enable_default_location_filters: bool,
    #[serde(alias = "GlobalLocationPreferenceFilters")]
    pub global_location_preference_filters: Vec<LocationPreferenceFilterDef>,
    #[serde(alias = "CountryLocationPreferenceFilters")]
    pub country_location_preference_filters: HashMap<
        String,
        Vec<LocationPreferenceFilterDef>,
    >,
    #[serde(alias = "SubdivisionLocationPreferenceFilters")]
    pub subdivision_location_preference_filters: HashMap<
        String,
        HashMap<String, Vec<LocationPreferenceFilterDef>>,
    >,
    #[serde(alias = "ProximityFilter")]
    pub proximity_filter: ProximityFilterDef,
    #[serde(alias = "CountryProximityFilters")]
    pub country_proximity_filters: HashMap<String, ProximityFilterDef>,
    #[serde(alias = "SubdivisionProximityFilters")]
    pub subdivision_proximity_filters: HashMap<
        String,
        HashMap<String, ProximityFilterDef>,
    >,
    #[serde(alias = "GeometryFilters")]
    pub geometry_filters: Vec<GeometryFilterDef>,
    #[serde(alias = "CountryGeometryFilters")]
    pub country_geometry_filters: HashMap<String, Vec<GeometryFilterDef>>,
    #[serde(alias = "SubdivisionGeometryFilters")]
    pub subdivision_geometry_filters: HashMap<
        String,
        HashMap<String, Vec<GeometryFilterDef>>,
    >,
    #[serde(alias = "NeighborFilters")]
    pub neighbor_filters: Vec<NeighborFilterDef>,
    #[serde(alias = "UsedLocationsPaths")]
    pub used_locations_paths: Vec<String>,
    #[serde(alias = "GlobalExternalDataFiles")]
    pub global_external_data_files: Vec<String>,
    #[serde(alias = "CountryExternalDataFiles")]
    pub country_external_data_files: HashMap<String, Vec<String>>,
    #[serde(alias = "SubdivisionExternalDataFiles")]
    pub subdivision_external_data_files: HashMap<String, serde_json::Value>,
    #[serde(alias = "GlobalLocationProbability")]
    pub global_location_probability: LocationProbabilityDef,
    #[serde(alias = "CountryLocationProbabilities")]
    pub country_location_probabilities: HashMap<String, LocationProbabilityDef>,
    #[serde(alias = "SubdivisionLocationProbabilities")]
    pub subdivision_location_probabilities: HashMap<
        String,
        HashMap<String, LocationProbabilityDef>,
    >,
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LocationProbabilityDef {
    #[serde(alias = "DefaultWeight")]
    pub default_weight: i32,
    #[serde(alias = "WeightOverrides")]
    pub weight_overrides: Vec<LocationWeightOverrideDef>,
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LocationWeightOverrideDef {
    #[serde(alias = "Expression")]
    pub expression: String,
    #[serde(alias = "Weight")]
    pub weight: i32,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
#[derive(Default)]
pub struct LocationPreferenceFilterDef {
    #[serde(alias = "Expression")]
    pub expression: String,
    #[serde(alias = "Percentage")]
    pub percentage: Option<i32>,
    #[serde(alias = "Fill")]
    pub fill: bool,
    #[serde(alias = "LocationTag")]
    pub location_tag: Option<String>,
    #[serde(alias = "MinMinDistance")]
    pub min_min_distance: Option<i32>,
    #[serde(alias = "ProximityFilter")]
    pub proximity_filter: ProximityFilterDef,
    #[serde(alias = "NeighborFilters")]
    pub neighbor_filters: Vec<NeighborFilterDef>,
    #[serde(alias = "GeometryFilters")]
    pub geometry_filters: Vec<GeometryFilterDef>,
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GeometryFilterDef {
    #[serde(alias = "FilePath")]
    pub file_path: String,
    #[serde(alias = "InclusionMode")]
    pub inclusion_mode: String,
    #[serde(alias = "CombinationMode")]
    pub combination_mode: String,
}
impl GeometryFilterDef {
    pub fn locations_inside(&self) -> bool {
        self.inclusion_mode != "exclude"
    }
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NeighborFilterDef {
    #[serde(alias = "CheckEachCardinalDirectionSeparately")]
    pub check_each_cardinal_direction_separately: bool,
    #[serde(alias = "Radius")]
    pub radius: i32,
    #[serde(alias = "Expression")]
    pub expression: String,
    #[serde(alias = "Limit")]
    pub limit: Option<i32>,
    #[serde(alias = "Bound")]
    pub bound: String,
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProximityFilterDef {
    #[serde(alias = "LocationsPath")]
    pub locations_path: String,
    #[serde(alias = "Radius")]
    pub radius: i32,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DistributionStrategy {
    #[serde(alias = "Key")]
    pub key: Option<String>,
    #[serde(alias = "LocationCountGoal")]
    pub location_count_goal: i32,
    #[serde(alias = "MinMinDistance")]
    pub min_min_distance: i32,
    #[serde(alias = "FixedMinDistance")]
    pub fixed_min_distance: i32,
    #[serde(alias = "TreatCountriesAsSingleSubdivision")]
    pub treat_countries_as_single_subdivision: Vec<String>,
    #[serde(alias = "CountryDistributionFromMap")]
    pub country_distribution_from_map: Option<String>,
    #[serde(alias = "CoverageDensityTuningFactor")]
    pub coverage_density_tuning_factor: Option<f64>,
    #[serde(alias = "CoverageDensityClusterSize")]
    pub coverage_density_cluster_size: Option<i32>,
}
impl Default for DistributionStrategy {
    fn default() -> Self {
        DistributionStrategy {
            key: None,
            location_count_goal: 0,
            min_min_distance: 0,
            fixed_min_distance: 0,
            treat_countries_as_single_subdivision: Vec::new(),
            country_distribution_from_map: None,
            coverage_density_tuning_factor: Some(0.6),
            coverage_density_cluster_size: Some(3),
        }
    }
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MapOutput {
    #[serde(alias = "LocationTags")]
    pub location_tags: Vec<String>,
    #[serde(alias = "PanoIdCountryCodes")]
    pub pano_id_country_codes: Vec<String>,
    #[serde(alias = "GlobalHeadingExpression")]
    pub global_heading_expression: Option<String>,
    #[serde(alias = "CountryHeadingExpressions")]
    pub country_heading_expressions: HashMap<String, String>,
    #[serde(alias = "GlobalZoom")]
    pub global_zoom: Option<f64>,
    #[serde(alias = "GlobalPitch")]
    pub global_pitch: Option<f64>,
    #[serde(alias = "PanoVerificationStrategy")]
    pub pano_verification_strategy: Option<String>,
    #[serde(alias = "PanoVerificationExpression")]
    pub pano_verification_expression: Option<String>,
}
