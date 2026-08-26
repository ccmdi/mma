//! QuickJS procedure host. Loads a plugin-authored ES module bundle and drives it
//! through the `Procedure` shapes. No provider logic lives here.
//!
//! The module's named exports are the entry points: `request`+`map` (RequestMap),
//! `map` (MapOnly) or `run` (Run). `query` is a second optional export outside the
//! shapes, and `configure` is called before every entry point when the module has
//! one -- with `null` when the run carries no configuration, since one context serves
//! every borrower of a pooled procedure. The boundary is JSON: a batch arrives as
//! `JSON.parse`d rows and every entry point answers with plain JS values.
//!
//! Host services live on a global `mma` object: `fetch`, `fetchMany`, `classify`,
//! `sidecar`, `log`, `progress`, `fail`, `aborted`. They are synchronous -- the guest
//! blocks while the host works, which is how a procedure gets request width out of
//! `fetchMany`. `fetch`, `fetchMany` and `sidecar` reach outside the process, so they
//! are limited to `run` and `query`; the rest are open to `map` as well. `request`
//! runs against no host at all: it is pure by construction.
//!
//! The `mma` natives have to be `'static` while the host is only borrowed for one
//! call, so the guest runs on a scoped thread and the natives reach the host over a
//! channel serviced by the calling thread. That loop is also where `host.aborted()`
//! is polled, so a guest that never yields can still be interrupted.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime};

use rquickjs::function::{Opt, Rest};
use rquickjs::{
    Array, ArrayBuffer, CatchResultExt, CaughtError, Context, Ctx, Function, Module, Object,
    Runtime, TypedArray, Value,
};

use super::{HttpRequestSpec, HttpResponse, PatchEntry, ProcHost, ProcShape, Procedure};
use crate::sidecar::SidecarStream;
use crate::types::{AppError, AppResult};

/// Ceiling on one runtime's heap. Procedures decode whole responses in memory, so this
/// is generous; it exists to turn a runaway allocation into an error, not an OOM.
const MEMORY_LIMIT: usize = 512 * 1024 * 1024;
/// Guest stack ceiling, well under the worker thread's own stack.
const STACK_LIMIT: usize = 1024 * 1024;
/// How often the calling thread wakes to re-check `host.aborted()` while the guest runs.
const ABORT_POLL: Duration = Duration::from_millis(25);
/// Where the module namespace is parked between calls, so entry points are looked up
/// without re-evaluating the module.
const EXPORTS: &str = "__mma_exports";

// Modules this thread has loaded, so the pool tests can count them without seeing
// loads from tests running beside them.
#[cfg(test)]
thread_local! {
    pub(crate) static LOADS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Globals bare QuickJS does not provide but bundled procedure code expects.
const PRELUDE: &str = r#"
(function () {
  'use strict';
  function TextEncoder() {}
  TextEncoder.prototype.encoding = 'utf-8';
  TextEncoder.prototype.encode = function (input) {
    var s = input === undefined ? '' : String(input);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      }
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  };

  function bytesOf(input) {
    if (input === undefined || input === null) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input.buffer instanceof ArrayBuffer) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return new Uint8Array(input);
  }

  function TextDecoder(label) {
    var enc = (label === undefined ? 'utf-8' : String(label)).toLowerCase();
    if (enc !== 'utf-8' && enc !== 'utf8' && enc !== 'unicode-1-1-utf-8') {
      throw new RangeError('TextDecoder supports utf-8 only, got ' + enc);
    }
  }
  TextDecoder.prototype.encoding = 'utf-8';
  TextDecoder.prototype.decode = function (input) {
    var b = bytesOf(input);
    var s = '', cps = [], i = 0, n = b.length;
    while (i < n) {
      var a = b[i++], cp, need;
      if (a < 0x80) { cps.push(a); continue; }
      else if ((a & 0xe0) === 0xc0) { cp = a & 0x1f; need = 1; }
      else if ((a & 0xf0) === 0xe0) { cp = a & 0x0f; need = 2; }
      else if ((a & 0xf8) === 0xf0) { cp = a & 0x07; need = 3; }
      else { cps.push(0xfffd); continue; }
      var ok = true;
      for (var k = 0; k < need; k++) {
        if (i >= n || (b[i] & 0xc0) !== 0x80) { ok = false; break; }
        cp = (cp << 6) | (b[i++] & 0x3f);
      }
      var min = need === 1 ? 0x80 : need === 2 ? 0x800 : 0x10000;
      if (!ok || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cps.push(0xfffd);
      else cps.push(cp);
      if (cps.length >= 4096) { s += String.fromCodePoint.apply(null, cps); cps.length = 0; }
    }
    return cps.length ? s + String.fromCodePoint.apply(null, cps) : s;
  };

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function btoa(input) {
    var s = String(input), out = '';
    for (var i = 0; i < s.length; i += 3) {
      var c0 = s.charCodeAt(i);
      var c1 = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      var c2 = i + 2 < s.length ? s.charCodeAt(i + 2) : 0;
      if (c0 > 255 || c1 > 255 || c2 > 255) {
        throw new Error('btoa: string contains characters outside of the Latin1 range');
      }
      var n = (c0 << 16) | (c1 << 8) | c2;
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
        + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=')
        + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function atob(input) {
    var s = String(input).replace(/[\t\n\f\r ]/g, '').replace(/=+$/, '');
    if (s.length % 4 === 1) throw new Error('atob: invalid base64');
    var out = '', bits = 0, held = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64.indexOf(s[i]);
      if (v < 0) throw new Error('atob: invalid base64');
      held = (held << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((held >> bits) & 255); }
    }
    return out;
  }

  function fmt(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
    try { var j = JSON.stringify(v); return j === undefined ? String(v) : j; }
    catch (e) { return String(v); }
  }
  function emit(level) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
      mma.log(level, parts.join(' '));
    };
  }

  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
  globalThis.btoa = btoa;
  globalThis.atob = atob;
  globalThis.console = {
    debug: emit(0), log: emit(1), info: emit(1), warn: emit(2), error: emit(3),
  };
})();
"#;

// ---------------------------------------------------------------------------
// Host bridge
// ---------------------------------------------------------------------------

enum HostReq {
    Fetch(HttpRequestSpec),
    FetchMany(Vec<HttpRequestSpec>),
    Classify {
        dataset: String,
        lat: f64,
        lng: f64,
    },
    Sidecar {
        plugin_id: String,
        command: String,
        payload: String,
    },
    /// The next line of the sidecar the guest started; pulled one at a time so the
    /// host stays free to service the calls a line handler makes.
    SidecarNext,
    Progress(u32),
    Fail(u32),
    Aborted,
}

enum HostRep {
    Fetch(AppResult<HttpResponse>),
    FetchMany(Vec<AppResult<HttpResponse>>),
    Classify(AppResult<Option<String>>),
    Sidecar(AppResult<()>),
    SidecarLine(String),
    SidecarEnd(AppResult<()>),
    Unit,
    Aborted(bool),
}

/// Guest-thread messages. The call's result travels back through the join handle;
/// `Done` only says the call is over, so the servicing loop also stops for a guest
/// thread that unwound.
enum Msg {
    Host(HostReq),
    Done,
}

/// The guest thread's end of the host channel. Held by the `mma` natives, which are
/// `'static`, so nothing here may borrow the host.
struct Bridge {
    tx: Sender<Msg>,
    rx: Receiver<HostRep>,
}

impl Bridge {
    fn call(&self, req: HostReq) -> AppResult<HostRep> {
        let gone = || AppError("procedure host is no longer attached".into());
        self.tx.send(Msg::Host(req)).map_err(|_| gone())?;
        self.rx.recv().map_err(|_| gone())
    }
}

fn service(host: &mut dyn ProcHost, stream: &mut Option<SidecarStream>, req: HostReq) -> HostRep {
    match req {
        HostReq::Fetch(spec) => HostRep::Fetch(host.fetch(&spec)),
        HostReq::FetchMany(specs) => HostRep::FetchMany(host.fetch_many(&specs)),
        HostReq::Classify { dataset, lat, lng } => {
            HostRep::Classify(host.classify(&dataset, lat, lng))
        }
        HostReq::Sidecar {
            plugin_id,
            command,
            payload,
        } => {
            if stream.is_some() {
                return HostRep::Sidecar(Err(AppError(
                    "mma.sidecar cannot be called from a line handler".into(),
                )));
            }
            HostRep::Sidecar(host.sidecar(&plugin_id, &command, &payload).map(|s| {
                *stream = Some(s);
            }))
        }
        HostReq::SidecarNext => match stream.as_mut().and_then(|s| s.next()) {
            Some(Ok(line)) => HostRep::SidecarLine(line),
            Some(Err(e)) => {
                *stream = None;
                HostRep::SidecarEnd(Err(e))
            }
            None => {
                *stream = None;
                HostRep::SidecarEnd(Ok(()))
            }
        },
        HostReq::Progress(units) => {
            host.progress(units);
            HostRep::Unit
        }
        HostReq::Fail(id) => {
            host.fail(id);
            HostRep::Unit
        }
        HostReq::Aborted => HostRep::Aborted(host.aborted()),
    }
}

/// Stand-in host for the call that gets none: `request`.
struct NoHost;

impl ProcHost for NoHost {
    fn fetch(&mut self, _req: &HttpRequestSpec) -> AppResult<HttpResponse> {
        Err(AppError("procedure has no host attached".into()))
    }
    fn classify(&mut self, _dataset: &str, _lat: f64, _lng: f64) -> AppResult<Option<String>> {
        Err(AppError("procedure has no host attached".into()))
    }
    fn sidecar(
        &mut self,
        _plugin_id: &str,
        _command: &str,
        _payload_json: &str,
    ) -> AppResult<SidecarStream> {
        Err(AppError("procedure has no host attached".into()))
    }
    fn progress(&mut self, _units: u32) {}
    fn fail(&mut self, _id: u32) {}
    fn aborted(&self) -> bool {
        false
    }
}

// ---------------------------------------------------------------------------
// Value marshalling
// ---------------------------------------------------------------------------

fn throw(ctx: &Ctx<'_>, msg: impl std::fmt::Display) -> rquickjs::Error {
    match rquickjs::String::from_str(ctx.clone(), &msg.to_string()) {
        Ok(s) => ctx.throw(s.into_value()),
        Err(e) => e,
    }
}

/// Closures naming `'js` in both an argument and the return need it unified
/// explicitly; inference hands them separate lifetimes.
fn value_fn<F>(f: F) -> F
where
    F: for<'js> Fn(Ctx<'js>, Value<'js>) -> rquickjs::Result<Value<'js>> + 'static,
{
    f
}

fn sidecar_fn<F>(f: F) -> F
where
    F: for<'js> Fn(
            Ctx<'js>,
            String,
            String,
            String,
            Opt<Function<'js>>,
        ) -> rquickjs::Result<Vec<String>>
        + 'static,
{
    f
}

fn classify_fn<F>(f: F) -> F
where
    F: for<'js> Fn(Ctx<'js>, String, f64, f64) -> rquickjs::Result<Value<'js>> + 'static,
{
    f
}

fn js_string(v: &rquickjs::String<'_>) -> AppResult<String> {
    v.to_string().map_err(|e| AppError(e.to_string()))
}

fn bytes_from_js(v: &Value<'_>) -> AppResult<Vec<u8>> {
    if let Some(s) = v.as_string() {
        return Ok(js_string(s)?.into_bytes());
    }
    if let Ok(t) = TypedArray::<u8>::from_value(v.clone()) {
        if let Some(b) = t.as_bytes() {
            return Ok(b.to_vec());
        }
    }
    if let Some(b) = v
        .as_object()
        .and_then(|o| ArrayBuffer::from_object(o.clone()))
        .and_then(|a| a.as_bytes().map(<[u8]>::to_vec))
    {
        return Ok(b);
    }
    Err(AppError(
        "expected a string, Uint8Array or ArrayBuffer".into(),
    ))
}

fn read_request(v: &Value<'_>) -> AppResult<HttpRequestSpec> {
    let obj = v
        .as_object()
        .ok_or_else(|| AppError("request must be an object".into()))?;
    let undef = || Value::new_undefined(obj.ctx().clone());
    let method: String = obj
        .get("method")
        .map_err(|_| AppError("request.method must be a string".into()))?;
    let url: String = obj
        .get("url")
        .map_err(|_| AppError("request.url must be a string".into()))?;

    let raw: Value = obj.get("headers").unwrap_or_else(|_| undef());
    let mut headers = Vec::new();
    if let Some(h) = raw.as_object() {
        for entry in h.props::<String, Value>() {
            let (k, val) = entry.map_err(|e| AppError(format!("request.headers: {e}")))?;
            let s = val
                .as_string()
                .ok_or_else(|| AppError(format!("request header `{k}` is not a string")))?;
            headers.push((k, js_string(s)?));
        }
    } else if !raw.is_undefined() && !raw.is_null() {
        return Err(AppError("request.headers must be an object".into()));
    }

    let raw_body: Value = obj.get("body").unwrap_or_else(|_| undef());
    let body = if raw_body.is_undefined() || raw_body.is_null() {
        None
    } else {
        Some(bytes_from_js(&raw_body).map_err(|e| AppError(format!("request.body: {}", e.0)))?)
    };
    Ok(HttpRequestSpec {
        method,
        url,
        headers,
        body,
    })
}

fn response_to_js<'js>(ctx: &Ctx<'js>, r: &HttpResponse) -> rquickjs::Result<Value<'js>> {
    let obj = Object::new(ctx.clone())?;
    obj.set("status", r.status)?;
    obj.set("body", TypedArray::new(ctx.clone(), r.body.clone())?)?;
    Ok(obj.into_value())
}

/// A request the host could not answer comes back as status 0 with an empty body,
/// which the guest reads as a failure like any other non-2xx.
fn failed_response() -> HttpResponse {
    HttpResponse {
        status: 0,
        body: Vec::new(),
    }
}

fn read_patches<'js>(ctx: &Ctx<'js>, v: Value<'js>) -> AppResult<Vec<PatchEntry>> {
    let arr = Array::from_value(v)
        .map_err(|_| AppError("procedure did not answer with an array of patches".into()))?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter::<Value>().enumerate() {
        let item = item.map_err(|e| AppError(format!("patch {i}: {e}")))?;
        let obj = item
            .as_object()
            .ok_or_else(|| AppError(format!("patch {i} is not an object")))?;
        let id: u32 = obj
            .get("id")
            .map_err(|_| AppError(format!("patch {i}: `id` must be a number")))?;
        let patch: Value = obj
            .get("patch")
            .map_err(|_| AppError(format!("patch {i}: missing `patch`")))?;
        let json = ctx
            .json_stringify(patch)
            .map_err(|e| AppError(format!("patch {i}: {e}")))?
            .ok_or_else(|| AppError(format!("patch {i}: `patch` is not serializable")))?;
        out.push(PatchEntry {
            id,
            patch: js_string(&json)?,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Host object
// ---------------------------------------------------------------------------

fn stub<'js>(ctx: &Ctx<'js>, obj: &Object<'js>, name: &str, msg: String) -> rquickjs::Result<()> {
    obj.set(
        name,
        Function::new(ctx.clone(), move |ctx: Ctx<'_>| -> rquickjs::Result<()> {
            Err(throw(&ctx, &msg))
        })?,
    )
}

/// Builds the global `mma`. With no bridge every host-backed method is detached,
/// which is what the module sees while it is being evaluated at load.
fn install_mma<'js>(
    ctx: &Ctx<'js>,
    bridge: Option<Rc<Bridge>>,
    allow_effects: bool,
) -> AppResult<()> {
    let jerr = |e: rquickjs::Error| AppError(e.to_string());
    let obj = Object::new(ctx.clone()).map_err(jerr)?;
    obj.set(
        "log",
        Function::new(ctx.clone(), |level: u32, msg: String| match level {
            0 => log::debug!("{msg}"),
            1 => log::info!("{msg}"),
            2 => log::warn!("{msg}"),
            _ => log::error!("{msg}"),
        })
        .map_err(jerr)?,
    )
    .map_err(jerr)?;
    match bridge {
        Some(b) => install_host_calls(ctx, &obj, b, allow_effects),
        None => [
            "fetch",
            "fetchMany",
            "classify",
            "sidecar",
            "progress",
            "fail",
            "aborted",
        ]
        .iter()
        .try_for_each(|n| stub(ctx, &obj, n, "procedure has no host attached".into())),
    }
    .map_err(jerr)?;
    ctx.globals().set("mma", obj).map_err(jerr)
}

fn install_host_calls<'js>(
    ctx: &Ctx<'js>,
    obj: &Object<'js>,
    bridge: Rc<Bridge>,
    allow_effects: bool,
) -> rquickjs::Result<()> {
    if allow_effects {
        let b = bridge.clone();
        obj.set(
            "fetch",
            Function::new(
                ctx.clone(),
                value_fn(move |ctx: Ctx<'_>, req: Value<'_>| {
                    let spec = read_request(&req).map_err(|e| throw(&ctx, e))?;
                    match b.call(HostReq::Fetch(spec)) {
                        Ok(HostRep::Fetch(Ok(r))) => response_to_js(&ctx, &r),
                        Ok(HostRep::Fetch(Err(e))) | Err(e) => Err(throw(&ctx, e)),
                        Ok(_) => Err(throw(&ctx, "host answered the wrong call")),
                    }
                }),
            )?,
        )?;
        let b = bridge.clone();
        obj.set(
            "fetchMany",
            Function::new(
                ctx.clone(),
                value_fn(move |ctx: Ctx<'_>, reqs: Value<'_>| {
                    let arr = Array::from_value(reqs)
                        .map_err(|_| throw(&ctx, "mma.fetchMany expects an array of requests"))?;
                    let mut specs = Vec::with_capacity(arr.len());
                    for item in arr.iter::<Value>() {
                        specs.push(read_request(&item?).map_err(|e| throw(&ctx, e))?);
                    }
                    let results = match b.call(HostReq::FetchMany(specs)) {
                        Ok(HostRep::FetchMany(r)) => r,
                        Ok(_) => return Err(throw(&ctx, "host answered the wrong call")),
                        Err(e) => return Err(throw(&ctx, e)),
                    };
                    let out = Array::new(ctx.clone())?;
                    for (i, r) in results.iter().enumerate() {
                        let resp = match r {
                            Ok(resp) => response_to_js(&ctx, resp)?,
                            Err(e) => {
                                if e.0 != super::engine::CANCELLED {
                                    log::debug!("[procedure] fetchMany: {e}");
                                }
                                response_to_js(&ctx, &failed_response())?
                            }
                        };
                        out.set(i, resp)?;
                    }
                    Ok(out.into_value())
                }),
            )?,
        )?;
        let b = bridge.clone();
        obj.set(
            "sidecar",
            Function::new(
                ctx.clone(),
                sidecar_fn(
                    move |ctx: Ctx<'_>,
                          plugin_id: String,
                          command: String,
                          payload: String,
                          on_line: Opt<Function<'_>>| {
                        match b.call(HostReq::Sidecar {
                            plugin_id,
                            command,
                            payload,
                        }) {
                            Ok(HostRep::Sidecar(Ok(()))) => {}
                            Ok(HostRep::Sidecar(Err(e))) | Err(e) => return Err(throw(&ctx, e)),
                            Ok(_) => return Err(throw(&ctx, "host answered the wrong call")),
                        }
                        let mut lines = Vec::new();
                        loop {
                            match b.call(HostReq::SidecarNext) {
                                Ok(HostRep::SidecarLine(line)) => {
                                    if let Some(f) = &on_line.0 {
                                        f.call::<_, ()>((line.clone(),))?;
                                    }
                                    lines.push(line);
                                }
                                Ok(HostRep::SidecarEnd(Ok(()))) => return Ok(lines),
                                Ok(HostRep::SidecarEnd(Err(e))) | Err(e) => {
                                    return Err(throw(&ctx, e))
                                }
                                Ok(_) => return Err(throw(&ctx, "host answered the wrong call")),
                            }
                        }
                    },
                ),
            )?,
        )?;
    } else {
        for name in ["fetch", "fetchMany", "sidecar"] {
            stub(
                ctx,
                obj,
                name,
                format!("mma.{name} is only available to `run`-shaped procedures"),
            )?;
        }
    }

    let b = bridge.clone();
    obj.set(
        "classify",
        Function::new(
            ctx.clone(),
            classify_fn(move |ctx: Ctx<'_>, dataset: String, lat: f64, lng: f64| {
                match b.call(HostReq::Classify { dataset, lat, lng }) {
                    Ok(HostRep::Classify(Ok(Some(name)))) => {
                        Ok(rquickjs::String::from_str(ctx.clone(), &name)?.into_value())
                    }
                    Ok(HostRep::Classify(Ok(None))) => Ok(Value::new_null(ctx.clone())),
                    Ok(HostRep::Classify(Err(e))) | Err(e) => Err(throw(&ctx, e)),
                    Ok(_) => Err(throw(&ctx, "host answered the wrong call")),
                }
            }),
        )?,
    )?;
    let b = bridge.clone();
    obj.set(
        "progress",
        Function::new(ctx.clone(), move |units: u32| {
            let _ = b.call(HostReq::Progress(units));
        })?,
    )?;
    let b = bridge.clone();
    obj.set(
        "fail",
        Function::new(ctx.clone(), move |id: u32| {
            let _ = b.call(HostReq::Fail(id));
        })?,
    )?;
    obj.set(
        "aborted",
        Function::new(ctx.clone(), move || {
            matches!(bridge.call(HostReq::Aborted), Ok(HostRep::Aborted(true)))
        })?,
    )
}

// ---------------------------------------------------------------------------
// Procedure
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default)]
struct Exports {
    request: bool,
    map: bool,
    run: bool,
    query: bool,
    configure: bool,
}

fn detect_shape(e: &Exports, origin: &str) -> AppResult<ProcShape> {
    if e.request {
        if !e.map {
            return Err(AppError(format!(
                "{origin}: module exports `request` without `map`"
            )));
        }
        Ok(ProcShape::RequestMap)
    } else if e.run {
        Ok(ProcShape::Run)
    } else if e.map {
        Ok(ProcShape::MapOnly)
    } else {
        Err(AppError(format!(
            "{origin}: module exports no procedure entry point (`request`+`map`, `map` or `run`)"
        )))
    }
}

pub struct JsProcedure {
    /// Held for the interrupt handler and the memory limit; the context keeps its own
    /// reference to it.
    _runtime: Runtime,
    context: Context,
    shape: ProcShape,
    exports: Exports,
    origin: String,
    /// Raised by the servicing loop when the run is aborted; the runtime's interrupt
    /// handler reads it, so a guest that never yields still stops.
    interrupt: Arc<AtomicBool>,
    /// Run configuration, replayed through `configure` before every call.
    config: Option<String>,
}

impl std::fmt::Debug for JsProcedure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsProcedure")
            .field("origin", &self.origin)
            .field("shape", &self.shape)
            .finish()
    }
}

impl JsProcedure {
    pub fn load(path: &Path) -> AppResult<JsProcedure> {
        let src = std::fs::read_to_string(path)?;
        JsProcedure::load_source(&src, &path.display().to_string())
    }

    pub fn load_source(src: &str, origin: &str) -> AppResult<JsProcedure> {
        #[cfg(test)]
        LOADS.with(|c| c.set(c.get() + 1));
        let err = |e: rquickjs::Error| AppError(format!("{origin}: {e}"));
        let runtime = Runtime::new().map_err(err)?;
        runtime.set_memory_limit(MEMORY_LIMIT);
        runtime.set_max_stack_size(STACK_LIMIT);
        let interrupt = Arc::new(AtomicBool::new(false));
        let flag = interrupt.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || flag.load(Ordering::Relaxed))));
        let context = Context::full(&runtime).map_err(err)?;

        let exports = context.with(|ctx| -> AppResult<Exports> {
            install_mma(&ctx, None, false)?;
            ctx.eval::<(), _>(PRELUDE)
                .catch(&ctx)
                .map_err(|e| AppError(format!("{origin}: prelude: {}", fmt_caught(&e))))?;
            let ns = declare(&ctx, src, origin)?;
            let found = Exports {
                request: ns.contains_key("request").unwrap_or(false),
                map: ns.contains_key("map").unwrap_or(false),
                run: ns.contains_key("run").unwrap_or(false),
                query: ns.contains_key("query").unwrap_or(false),
                configure: ns.contains_key("configure").unwrap_or(false),
            };
            ctx.globals().set(EXPORTS, ns).map_err(err)?;
            Ok(found)
        })?;

        Ok(JsProcedure {
            _runtime: runtime,
            context,
            shape: detect_shape(&exports, origin)?,
            exports,
            origin: origin.to_string(),
            interrupt,
            config: None,
        })
    }

    fn err(&self, msg: impl std::fmt::Display) -> AppError {
        AppError(format!("{}: {msg}", self.origin))
    }

    /// Runs `body` against the module on a worker thread, servicing the host calls it
    /// makes here until it reports the call is over.
    fn call<T, F>(&self, host: &mut dyn ProcHost, allow_effects: bool, body: F) -> AppResult<T>
    where
        T: Send,
        F: FnOnce(Ctx<'_>) -> AppResult<T> + Send,
    {
        self.interrupt.store(false, Ordering::Relaxed);
        let (msg_tx, msg_rx) = mpsc::channel::<Msg>();
        let (rep_tx, rep_rx) = mpsc::channel::<HostRep>();
        let bridge_tx = msg_tx.clone();
        let config = self.config.clone();

        let joined = std::thread::scope(|scope| {
            let worker = scope.spawn(move || {
                let _done = DoneGuard(msg_tx);
                self.context.with(|ctx| {
                    let bridge = Rc::new(Bridge {
                        tx: bridge_tx,
                        rx: rep_rx,
                    });
                    install_mma(&ctx, Some(bridge), allow_effects)?;
                    let out = self
                        .push_config(&ctx, config.as_deref())
                        .and_then(|()| body(ctx.clone()));
                    // Drop this call's channel ends rather than parking them in the JS heap.
                    install_mma(&ctx, None, false)?;
                    out
                })
            });
            let mut stream: Option<SidecarStream> = None;
            loop {
                match msg_rx.recv_timeout(ABORT_POLL) {
                    Ok(Msg::Host(req)) => {
                        if rep_tx.send(service(host, &mut stream, req)).is_err() {
                            break;
                        }
                    }
                    Ok(Msg::Done) | Err(RecvTimeoutError::Disconnected) => break,
                    Err(RecvTimeoutError::Timeout) => {
                        if host.aborted() {
                            self.interrupt.store(true, Ordering::Relaxed);
                        }
                    }
                }
            }
            worker.join()
        });
        self.interrupt.store(false, Ordering::Relaxed);
        joined.unwrap_or_else(|_| Err(self.err("procedure thread panicked")))
    }

    /// Optional `configure` export, called before every entry point. A call with no
    /// configuration passes `null` rather than skipping: one context serves every
    /// borrower of a pooled procedure, so silence would leave the last run's
    /// configuration standing.
    fn push_config(&self, ctx: &Ctx<'_>, config: Option<&str>) -> AppResult<()> {
        if !self.exports.configure {
            return Ok(());
        }
        let arg = ctx
            .json_parse(config.unwrap_or("null"))
            .map_err(|e| self.err(format!("configuration JSON is invalid: {e}")))?;
        self.invoke(ctx, "configure", vec![arg]).map(|_| ())
    }

    fn export<'js>(&self, ctx: &Ctx<'js>, name: &str) -> AppResult<Function<'js>> {
        ctx.globals()
            .get::<_, Object>(EXPORTS)
            .and_then(|ns| ns.get::<_, Function>(name))
            .map_err(|e| self.err(format!("export `{name}` is unavailable: {e}")))
    }

    fn caught<T>(&self, ctx: &Ctx<'_>, r: rquickjs::Result<T>) -> AppResult<T> {
        r.catch(ctx).map_err(|e| self.err(fmt_caught(&e)))
    }

    /// Calls an export and settles the answer, so an `async` entry point whose awaits
    /// resolve on the microtask queue behaves like a synchronous one.
    fn invoke<'js>(
        &self,
        ctx: &Ctx<'js>,
        name: &str,
        args: Vec<Value<'js>>,
    ) -> AppResult<Value<'js>> {
        let f = self.export(ctx, name)?;
        let out = self.caught(ctx, f.call::<_, Value>((Rest(args),)))?;
        match out.as_promise() {
            Some(p) => self.caught(ctx, p.finish::<Value>()),
            None => Ok(out),
        }
    }

    fn rows<'js>(&self, ctx: &Ctx<'js>, batch: &[u8]) -> AppResult<Value<'js>> {
        ctx.json_parse(batch)
            .map_err(|e| self.err(format!("batch JSON is invalid: {e}")))
    }
}

/// Reports the end of a call even when the guest thread unwinds, so the servicing
/// loop cannot outlive it.
struct DoneGuard(Sender<Msg>);

impl Drop for DoneGuard {
    fn drop(&mut self) {
        let _ = self.0.send(Msg::Done);
    }
}

fn fmt_caught(e: &CaughtError<'_>) -> String {
    match e {
        CaughtError::Exception(ex) => {
            let msg = ex.message().unwrap_or_else(|| "exception".to_string());
            match ex.stack() {
                Some(s) if !s.trim().is_empty() => format!("{msg}\n{}", s.trim_end()),
                _ => msg,
            }
        }
        other => other.to_string().trim_end().to_string(),
    }
}

fn declare<'js>(ctx: &Ctx<'js>, src: &str, origin: &str) -> AppResult<Object<'js>> {
    let fail = |e: CaughtError<'_>| AppError(format!("{origin}: {}", fmt_caught(&e)));
    let (module, done) = Module::declare(ctx.clone(), "proc", src)
        .and_then(Module::eval)
        .catch(ctx)
        .map_err(fail)?;
    done.finish::<()>().catch(ctx).map_err(fail)?;
    module
        .namespace()
        .map_err(|e| AppError(format!("{origin}: module namespace is unavailable: {e}")))
}

impl Procedure for JsProcedure {
    fn shape(&self) -> ProcShape {
        self.shape
    }

    fn configure(&mut self, config_json: &str) -> AppResult<()> {
        self.config = Some(config_json.to_string());
        Ok(())
    }

    fn request(&mut self, batch: &[u8]) -> AppResult<HttpRequestSpec> {
        if self.shape != ProcShape::RequestMap {
            return Err(self.err("procedure shape does not implement request"));
        }
        let mut no_host = NoHost;
        self.call(&mut no_host, false, |ctx| {
            let rows = self.rows(&ctx, batch)?;
            let out = self.invoke(&ctx, "request", vec![rows])?;
            read_request(&out).map_err(|e| self.err(e.0))
        })
    }

    fn map(
        &mut self,
        batch: &[u8],
        response: &HttpResponse,
        host: &mut dyn ProcHost,
    ) -> AppResult<Vec<PatchEntry>> {
        if !matches!(self.shape, ProcShape::RequestMap | ProcShape::MapOnly) {
            return Err(self.err("procedure shape does not implement map"));
        }
        self.call(host, false, |ctx| {
            let rows = self.rows(&ctx, batch)?;
            let resp = response_to_js(&ctx, response).map_err(|e| self.err(e))?;
            let out = self.invoke(&ctx, "map", vec![rows, resp])?;
            read_patches(&ctx, out).map_err(|e| self.err(e.0))
        })
    }

    fn run(&mut self, batch: &[u8], host: &mut dyn ProcHost) -> AppResult<Vec<PatchEntry>> {
        if self.shape != ProcShape::Run {
            return Err(self.err("procedure shape does not implement run"));
        }
        self.call(host, true, |ctx| {
            let rows = self.rows(&ctx, batch)?;
            let out = self.invoke(&ctx, "run", vec![rows])?;
            read_patches(&ctx, out).map_err(|e| self.err(e.0))
        })
    }

    fn query(&mut self, input: &[u8], host: &mut dyn ProcHost) -> AppResult<Vec<u8>> {
        if !self.exports.query {
            return Err(self.err("module exports no `query`"));
        }
        self.call(host, true, |ctx| {
            let arg = ctx
                .json_parse(input)
                .map_err(|e| self.err(format!("query input JSON is invalid: {e}")))?;
            let out = self.invoke(&ctx, "query", vec![arg])?;
            let json = ctx
                .json_stringify(out)
                .map_err(|e| self.err(e))?
                .ok_or_else(|| self.err("query answered with a value JSON cannot represent"))?;
            Ok(js_string(&json).map_err(|e| self.err(e.0))?.into_bytes())
        })
    }
}

// ---------------------------------------------------------------------------
// Module cache
// ---------------------------------------------------------------------------

/// Loaded procedures keyed by resolved path. A cold load builds a runtime, a context
/// and evaluates the bundle, so a warm path costs a stat instead of all three.
struct PoolEntry {
    /// Last modified time and length of the file these were loaded from.
    stamp: Stamp,
    idle: Vec<JsProcedure>,
}

type Stamp = (Option<SystemTime>, u64);

fn pool() -> &'static Mutex<HashMap<PathBuf, PoolEntry>> {
    static P: std::sync::OnceLock<Mutex<HashMap<PathBuf, PoolEntry>>> = std::sync::OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stamp(path: &Path) -> Stamp {
    match std::fs::metadata(path) {
        Ok(m) => (m.modified().ok(), m.len()),
        Err(_) => (None, 0),
    }
}

/// A procedure on loan from the pool, returned when dropped. Every `Procedure`
/// method delegates: the borrower cannot tell it from a freshly loaded module.
pub struct PooledProcedure {
    proc: Option<JsProcedure>,
    path: PathBuf,
    stamp: Stamp,
}

/// Borrow a procedure for `path`, loading one only when the pool holds none for the
/// file as it currently stands. A changed module (rebuilt plugin, swapped resource)
/// invalidates every copy of it.
pub fn checkout(path: &Path) -> AppResult<PooledProcedure> {
    let stamp = stamp(path);
    let idle = {
        let mut pool = pool().lock()?;
        match pool.get_mut(path) {
            Some(e) if e.stamp == stamp => e.idle.pop(),
            Some(e) => {
                *e = PoolEntry {
                    stamp,
                    idle: Vec::new(),
                };
                None
            }
            None => None,
        }
    };
    let proc = match idle {
        Some(p) => p,
        None => JsProcedure::load(path)?,
    };
    Ok(PooledProcedure {
        proc: Some(proc),
        path: path.to_path_buf(),
        stamp,
    })
}

impl PooledProcedure {
    fn inner(&mut self) -> &mut JsProcedure {
        self.proc.as_mut().expect("procedure is held until drop")
    }
}

impl Drop for PooledProcedure {
    fn drop(&mut self) {
        let Some(mut proc) = self.proc.take() else {
            return;
        };
        // The next borrower configures before calling; not carrying this one's
        // configuration across keeps that a guarantee rather than a habit.
        proc.config = None;
        let Ok(mut pool) = pool().lock() else {
            return;
        };
        let entry = pool
            .entry(std::mem::take(&mut self.path))
            .or_insert(PoolEntry {
                stamp: self.stamp,
                idle: Vec::new(),
            });
        // The file changed while this was on loan: it was loaded from bytes that are
        // no longer there, so it retires instead of being pooled.
        if entry.stamp == self.stamp {
            entry.idle.push(proc);
        }
    }
}

impl Procedure for PooledProcedure {
    fn shape(&self) -> ProcShape {
        self.proc.as_ref().expect("held until drop").shape()
    }

    fn configure(&mut self, config_json: &str) -> AppResult<()> {
        self.inner().configure(config_json)
    }

    fn request(&mut self, batch: &[u8]) -> AppResult<HttpRequestSpec> {
        self.inner().request(batch)
    }

    fn map(
        &mut self,
        batch: &[u8],
        response: &HttpResponse,
        host: &mut dyn ProcHost,
    ) -> AppResult<Vec<PatchEntry>> {
        self.inner().map(batch, response, host)
    }

    fn run(&mut self, batch: &[u8], host: &mut dyn ProcHost) -> AppResult<Vec<PatchEntry>> {
        self.inner().run(batch, host)
    }

    fn query(&mut self, input: &[u8], host: &mut dyn ProcHost) -> AppResult<Vec<u8>> {
        self.inner().query(input, host)
    }
}

#[cfg(test)]
#[path = "quickjs.test.rs"]
mod tests;
