//! Procedure engine: generic executor running procedures over paged location
//! batches. No per-procedure logic lives in Rust.

pub mod engine;
pub mod quickjs;

use crate::net::fetch::{HttpRequestSpec, HttpResponse};
use crate::plugins::borders;
use crate::plugins::sidecar;
use crate::plugins::sidecar::SidecarStream;
use crate::sv::pano::{PanoAnswer, PanoQuery};
use crate::types::{AppError, AppResult, Location};
use mma_algebra::Id;

/// One location's answer from a procedure, as the JSON its module emitted.
#[derive(Debug, Clone, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultEntry {
    pub id: Id<Location>,
    pub json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcShape {
    /// Pure compute: `map(batch)`, with no effectful host calls.
    Map,
    /// Procedure drives its own calls through the host: `run(batch, host)`.
    Run,
}

/// Host services exposed to a procedure. `map` and `run` both get one; only `run`
/// may reach the effectful ones (`fetch`, `panos`, `sidecar`). Rate limiting and abort are
/// enforced by the implementation, not the procedure.
pub trait ProcHost {
    /// Every request at once, answered in order. The host decides how many are in
    /// flight; a procedure that has several calls to make issues them here together
    /// instead of serializing them itself. One request failing does not fail the rest.
    fn fetch(&mut self, reqs: &[HttpRequestSpec]) -> Vec<AppResult<HttpResponse>>;
    /// Every pano lookup, answered aligned to `queries`.
    fn panos(&mut self, queries: &[PanoQuery]) -> Vec<PanoAnswer>;
    /// Where this host delivers partial results, when its caller listens for them.
    fn emitter(&self) -> Option<std::sync::Arc<engine::Partials>> {
        None
    }
    /// Locations within `radius_m` metres of a coordinate, nearest first, each carrying
    /// whichever of `fields` it had, as JSON. The host holds the index, so a procedure
    /// may ask once per row.
    fn neighbors(
        &mut self,
        _lat: f64,
        _lng: f64,
        _radius_m: f64,
        _fields: &[String],
    ) -> AppResult<String> {
        Err(AppError("mma.neighbors needs a running store".into()))
    }
    /// Point-in-polygon lookup against a local border dataset. `None` outside every feature.
    fn classify(&mut self, dataset: &str, lat: f64, lng: f64) -> AppResult<Option<String>> {
        Ok(borders::classify_points(dataset, &[(lat, lng)])?
            .into_iter()
            .next()
            .flatten())
    }
    /// Start one sidecar command; its output lines are pulled from the stream as they
    /// arrive, so the caller can report progress while the command still runs.
    fn sidecar(
        &mut self,
        plugin_id: &str,
        command: &str,
        payload_json: &str,
    ) -> AppResult<SidecarStream> {
        sidecar::sidecar_call_stream(plugin_id, command, payload_json)
    }
    fn progress(&mut self, units: u32);
    fn fail(&mut self, id: Id<Location>);
    fn aborted(&self) -> bool;
}

/// A provider procedure. Sole production impl is `quickjs::JsProcedure`;
/// engine tests use mocks. A batch is its rows as JSON text.
pub trait Procedure: Send {
    fn shape(&self) -> ProcShape;

    fn map(
        &mut self,
        _batch: &[u8],
        _host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<ResultEntry>> {
        Err(AppError("procedure shape does not implement map".into()))
    }

    fn run(
        &mut self,
        _batch: &[u8],
        _host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<ResultEntry>> {
        Err(AppError("procedure shape does not implement run".into()))
    }

    fn query(
        &mut self,
        _input: &[u8],
        _host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<u8>> {
        Err(AppError("procedure does not implement query".into()))
    }
}
