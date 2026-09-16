//! Procedure engine: generic executor running procedures over paged location
//! batches. No per-procedure logic lives in Rust.

pub mod engine;
pub mod quickjs;

use crate::plugins::borders;
use crate::plugins::sidecar;
use crate::plugins::sidecar::SidecarStream;
use crate::types::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct HttpRequestSpec {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// One location's result: a `LocationPatch` as JSON. Held as text until
/// `engine::to_updates` parses it, so the host stays free of store types.
#[derive(Debug, Clone, PartialEq)]
pub struct PatchEntry {
    pub id: u32,
    pub patch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcShape {
    /// Engine drives HTTP: `request(batch)` then `map(batch, response)`.
    RequestMap,
    /// Pure compute: `map(batch, empty response)` only.
    MapOnly,
    /// Procedure drives its own calls through the host: `run(batch, host)`.
    Run,
}

/// Host services exposed to a procedure. `map` and `run` both get one; only `run`
/// may reach the effectful ones (`fetch`, `sidecar`). Rate limiting and abort are
/// enforced by the implementation, not the procedure.
pub trait ProcHost {
    fn fetch(&mut self, req: &HttpRequestSpec) -> AppResult<HttpResponse>;
    /// Every request at once, answered in order. The host decides how many are in
    /// flight; a procedure that has several calls to make issues them here instead
    /// of serializing them itself. One request failing does not fail the rest.
    fn fetch_many(&mut self, reqs: &[HttpRequestSpec]) -> Vec<AppResult<HttpResponse>> {
        reqs.iter().map(|r| self.fetch(r)).collect()
    }
    /// Every request at once, each answer handed over the moment it lands, in
    /// completion order. The default answers in request order once everything is done.
    fn fetch_stream(
        &mut self,
        reqs: &[HttpRequestSpec],
        on_each: &mut dyn FnMut(usize, AppResult<HttpResponse>),
    ) {
        for (i, r) in self.fetch_many(reqs).into_iter().enumerate() {
            on_each(i, r);
        }
    }
    /// Where this host delivers partial results, when its caller listens for them.
    fn emitter(&self) -> Option<std::sync::Arc<engine::Partials>> {
        None
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
    fn fail(&mut self, id: u32);
    fn aborted(&self) -> bool;
}

/// A provider procedure. Sole production impl is `quickjs::JsProcedure`;
/// engine tests use mocks. A batch is its rows as JSON text.
pub trait Procedure: Send {
    fn shape(&self) -> ProcShape;

    fn request(&mut self, _batch: &[u8], _config: &str) -> AppResult<HttpRequestSpec> {
        Err(AppError(
            "procedure shape does not implement request".into(),
        ))
    }

    fn map(
        &mut self,
        _batch: &[u8],
        _response: &HttpResponse,
        _host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<PatchEntry>> {
        Err(AppError("procedure shape does not implement map".into()))
    }

    fn run(
        &mut self,
        _batch: &[u8],
        _host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<PatchEntry>> {
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
