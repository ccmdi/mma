//! Dev-only (Windows). Names whatever is holding the main thread: the event loop
//! stamps a heartbeat on every turn, and when it goes stale the main thread's
//! stack is captured and logged, once per episode, with the recovery time.

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Once, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Diagnostics::Debug::{
    GetThreadContext, RtlLookupFunctionEntry, RtlVirtualUnwind, SymFromAddrW,
    SymGetLineFromAddrW64, SymInitializeW, SymSetOptions, CONTEXT, CONTEXT_FULL_AMD64,
    IMAGEHLP_LINEW64, SYMBOL_INFOW, SYMOPT_DEFERRED_LOADS, SYMOPT_LOAD_LINES, SYMOPT_UNDNAME,
    UNW_FLAG_NHANDLER,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThreadId, OpenThread, ResumeThread, SuspendThread,
    THREAD_GET_CONTEXT, THREAD_QUERY_INFORMATION, THREAD_SUSPEND_RESUME,
};

const STALL_MS: u64 = 1000;
const POLL: Duration = Duration::from_millis(250);
const MAX_FRAMES: usize = 48;
const MAX_NAME: usize = 512;

#[repr(C, align(16))]
struct AlignedContext(CONTEXT);

static EPOCH: OnceLock<Instant> = OnceLock::new();
static HEARTBEAT: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Stamp from the event loop on every turn.
pub fn beat() {
    HEARTBEAT.store(now_ms(), Ordering::Relaxed);
}

/// Start monitoring the calling thread.
pub fn start() {
    let tid = unsafe { GetCurrentThreadId() };
    beat();
    thread::spawn(move || monitor(tid));
}

fn monitor(tid: u32) {
    let Some(thread) = open_thread(tid) else {
        return;
    };
    let mut inspected = None;
    let mut stalled = None;
    loop {
        thread::sleep(POLL);
        let beat = HEARTBEAT.load(Ordering::Relaxed);
        if let Some(since) = stalled.filter(|s| *s != beat) {
            log::warn!("[stall] main thread recovered after {}ms", beat - since);
            stalled = None;
        }
        if inspected == Some(beat) || now_ms().saturating_sub(beat) < STALL_MS {
            continue;
        }
        inspected = Some(beat);
        let frames = capture(thread);
        if is_idle(&frames) {
            continue;
        }
        stalled = Some(beat);
        log::warn!(
            "[stall] main thread unresponsive for {}ms:\n  {}",
            now_ms() - beat,
            frames.join("\n  ")
        );
    }
}

/// An idle loop is parked in `GetMessage`; a loop parked there under wry's
/// completion pump is waiting on WebView2 and counts as a stall.
fn is_idle(frames: &[String]) -> bool {
    frames.iter().take(3).any(|f| f.contains("GetMessage"))
        && !frames.iter().any(|f| f.contains("wait_with_pump"))
}

fn open_thread(tid: u32) -> Option<HANDLE> {
    let h = unsafe {
        OpenThread(
            THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME | THREAD_QUERY_INFORMATION,
            0,
            tid,
        )
    };
    (!h.is_null()).then_some(h)
}

/// The PDB sits beside the exe, which is not on dbghelp's default search path.
fn init_symbols() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_default();
        let path: Vec<u16> = exe_dir.as_os_str().encode_wide().chain([0]).collect();
        SymSetOptions(SYMOPT_UNDNAME | SYMOPT_DEFERRED_LOADS | SYMOPT_LOAD_LINES);
        SymInitializeW(GetCurrentProcess(), path.as_ptr(), 1);
    });
}

/// Suspends `thread` only for a lock-free unwind; symbolization runs after resume.
fn capture(thread: HANDLE) -> Vec<String> {
    init_symbols();
    let mut pcs = Vec::with_capacity(MAX_FRAMES);
    unsafe {
        if SuspendThread(thread) == u32::MAX {
            return pcs.into_iter().map(symbolize).collect();
        }
        let mut aligned: AlignedContext = std::mem::zeroed();
        let ctx = &mut aligned.0;
        ctx.ContextFlags = CONTEXT_FULL_AMD64;
        if GetThreadContext(thread, ctx) != 0 {
            while pcs.len() < MAX_FRAMES && ctx.Rip != 0 && ctx.Rsp != 0 {
                pcs.push(ctx.Rip);
                let mut base = 0u64;
                let entry = RtlLookupFunctionEntry(ctx.Rip, &mut base, std::ptr::null_mut());
                if entry.is_null() {
                    ctx.Rip = *(ctx.Rsp as *const u64);
                    ctx.Rsp += 8;
                } else {
                    let mut handler_data: *mut c_void = std::ptr::null_mut();
                    let mut establisher = 0u64;
                    RtlVirtualUnwind(
                        UNW_FLAG_NHANDLER,
                        base,
                        ctx.Rip,
                        entry,
                        ctx,
                        &mut handler_data,
                        &mut establisher,
                        std::ptr::null_mut(),
                    );
                }
            }
        }
        ResumeThread(thread);
    }
    pcs.into_iter().map(symbolize).collect()
}

fn symbolize(pc: u64) -> String {
    unsafe {
        let process = GetCurrentProcess();
        let mut buf = [0u64; (std::mem::size_of::<SYMBOL_INFOW>() + MAX_NAME * 2) / 8 + 1];
        let sym = buf.as_mut_ptr() as *mut SYMBOL_INFOW;
        (*sym).SizeOfStruct = std::mem::size_of::<SYMBOL_INFOW>() as u32;
        (*sym).MaxNameLen = MAX_NAME as u32;
        let mut displacement = 0u64;
        let name = if SymFromAddrW(process, pc, &mut displacement, sym) != 0 {
            let len = ((*sym).NameLen as usize).min(MAX_NAME);
            String::from_utf16_lossy(std::slice::from_raw_parts((*sym).Name.as_ptr(), len))
        } else {
            return format!("{pc:#x}");
        };
        let mut line: IMAGEHLP_LINEW64 = std::mem::zeroed();
        line.SizeOfStruct = std::mem::size_of::<IMAGEHLP_LINEW64>() as u32;
        let mut line_displacement = 0u32;
        if SymGetLineFromAddrW64(process, pc, &mut line_displacement, &mut line) != 0
            && !line.FileName.is_null()
        {
            let mut len = 0;
            while *line.FileName.add(len) != 0 {
                len += 1;
            }
            let file = String::from_utf16_lossy(std::slice::from_raw_parts(line.FileName, len));
            return format!("{name} ({file}:{})", line.LineNumber);
        }
        name
    }
}

#[cfg(test)]
#[path = "stall_reporter.test.rs"]
mod stall_reporter_tests;
