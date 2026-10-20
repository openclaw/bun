//! Opt-in source-search timing. Detailed start records survive a query that never returns.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const DEFAULT_MAX_BYTES: usize = 256 << 20;
const MAX_CONFIGURED_BYTES: usize = 2 << 30;
static LOG: OnceLock<Option<Log>> = OnceLock::new();

struct Log {
    started: Instant,
    next: AtomicU64,
    detail: Option<Vec<u8>>,
    output: Mutex<Output<File>>,
}

struct Output<W> {
    writer: W,
    bytes: usize,
    max_bytes: usize,
    stopped: bool,
    phases: HashMap<(usize, usize), (u64, &'static str)>,
}

impl<W: std::io::Write> Output<W> {
    fn write(&mut self, line: &[u8]) {
        if self.stopped {
            return;
        }
        if line.len() > self.max_bytes.saturating_sub(self.bytes) {
            let _ = self
                .writer
                .write_all(b"{\"event\":\"trace_limit\",\"complete\":false}\n");
            self.stopped = true;
            return;
        }
        if self.writer.write_all(line).is_err() {
            self.stopped = true;
            let _ = std::io::Write::write_fmt(
                &mut std::io::stderr().lock(),
                format_args!("aot: source trace write failed; trace is incomplete\n"),
            );
            return;
        }
        self.bytes += line.len();
    }
}

fn source_trace_max_bytes(value: Option<&[u8]>) -> Option<usize> {
    let Some(value) = value else { return Some(DEFAULT_MAX_BYTES) };
    let bytes = std::str::from_utf8(value).ok()?.parse::<usize>().ok()?;
    (1..=MAX_CONFIGURED_BYTES).contains(&bytes).then_some(bytes)
}

fn log() -> Option<&'static Log> {
    LOG.get_or_init(|| {
        let path = std::env::var_os("BUN_AOT_SOURCE_TRACE")?;
        let Some(max_bytes) = source_trace_max_bytes(bun_core::env_var::BUN_AOT_SOURCE_TRACE_MAX_BYTES::get()) else {
            let _ = std::io::Write::write_all(
                &mut std::io::stderr().lock(),
                b"aot: BUN_AOT_SOURCE_TRACE_MAX_BYTES must be an integer from 1 to 2147483648; source trace disabled\n",
            );
            return None;
        };
        match OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(writer) => Some(Log {
                started: Instant::now(),
                next: AtomicU64::new(1),
                detail: std::env::var("BUN_AOT_SOURCE_TRACE_DETAIL")
                    .ok()
                    .filter(|value| !value.is_empty())
                    .map(String::into_bytes),
                output: Mutex::new(Output {
                    writer,
                    bytes: 0,
                    max_bytes,
                    stopped: false,
                    phases: HashMap::new(),
                }),
            }),
            Err(error) => {
                let _ = std::io::Write::write_fmt(
                    &mut std::io::stderr().lock(),
                    format_args!("aot: cannot create source trace: {error}\n"),
                );
                None
            }
        }
    })
    .as_ref()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// The program address identifies retries of the same program only within this process.
#[derive(Clone, Copy)]
pub struct Trace {
    log: Option<&'static Log>,
    id: u64,
    program: usize,
}

impl Trace {
    pub fn new(program: usize) -> Self {
        let log = log();
        Self {
            log,
            id: log.map_or(0, |log| log.next.fetch_add(1, Ordering::Relaxed)),
            program,
        }
    }

    pub fn span(
        &self,
        worker: usize,
        phase: &'static str,
        file: Option<u32>,
        path: &[u8],
        node: Option<u32>,
    ) -> Option<Span> {
        let log = self.log?;
        let id = log.next.fetch_add(1, Ordering::Relaxed);
        let detailed = log
            .detail
            .as_ref()
            .is_some_and(|filter| path.windows(filter.len()).any(|part| part == filter));
        let is_phase = file.is_some() && node.is_none();
        let phase_changed = is_phase
            && log.output.lock().is_ok_and(|mut output| {
                output
                    .phases
                    .insert((self.program, worker), (self.id, phase))
                    != Some((self.id, phase))
            });
        let emitted_start = file.is_none() || detailed || phase_changed;
        let span = Span {
            trace: *self,
            id,
            started: Instant::now(),
            worker,
            phase,
            file,
            path: path.to_vec(),
            node,
            emitted_start,
        };
        if emitted_start {
            self.write(format!("\"event\":\"start\",{}", span.fields()));
        }
        Some(span)
    }

    pub fn counts(
        &self,
        worker: usize,
        turn: usize,
        held: usize,
        plain: usize,
        casts: usize,
        unions: usize,
    ) {
        if self.log.is_some() {
            self.write(format!("\"event\":\"counts\",\"worker\":{worker},\"turn\":{turn},\"held\":{held},\"plain\":{plain},\"casts\":{casts},\"unions\":{unions}"));
        }
    }

    pub fn fallback(
        &self,
        file: u32,
        path: &[u8],
        package: &[u8],
        name: &[u8],
        place: &[u8],
        affected: usize,
        newly_untyped: usize,
    ) {
        if self.log.is_some() {
            self.write(format!("\"event\":\"fallback\",\"reason\":\"boundary_type_limit\",\"file\":{file},\"path_hex\":\"{}\",\"package_hex\":\"{}\",\"name_hex\":\"{}\",\"place_hex\":\"{}\",\"affected\":{affected},\"newly_untyped\":{newly_untyped}", hex(path), hex(package), hex(name), hex(place)));
        }
    }

    fn write(&self, fields: String) {
        if let Some(log) = self.log {
            let line = format!(
                "{{\"v\":1,\"pid\":{},\"program\":{},\"attempt\":{},\"at_ns\":{},{} }}\n",
                std::process::id(),
                self.program,
                self.id,
                log.started.elapsed().as_nanos(),
                fields
            );
            if let Ok(mut output) = log.output.lock() {
                output.write(line.as_bytes());
            }
        }
    }
}

fn optional(value: Option<u32>) -> String {
    value.map_or_else(|| "null".into(), |value| value.to_string())
}

pub struct Span {
    trace: Trace,
    id: u64,
    started: Instant,
    worker: usize,
    phase: &'static str,
    file: Option<u32>,
    path: Vec<u8>,
    node: Option<u32>,
    emitted_start: bool,
}

impl Span {
    fn fields(&self) -> String {
        format!(
            "\"span\":{},\"worker\":{},\"phase\":\"{}\",\"file\":{},\"path_hex\":\"{}\",\"node\":{}",
            self.id,
            self.worker,
            self.phase,
            optional(self.file),
            hex(&self.path),
            optional(self.node)
        )
    }
}

impl Drop for Span {
    fn drop(&mut self) {
        let elapsed = self.started.elapsed();
        if self.emitted_start || elapsed.as_millis() >= 100 {
            self.trace.write(format!(
                "\"event\":\"{}\",\"elapsed_ns\":{},{}",
                if self.emitted_start { "end" } else { "slow" },
                elapsed.as_nanos(),
                self.fields()
            ));
        }
    }
}


// Native IR translation outlives source search. Keep its current body in thread-local state.
static NATIVE_CONFIG: OnceLock<Option<NativeConfig>> = OnceLock::new();

struct NativeConfig {
    filter: Option<Vec<u8>>,
    queries: bool,
}

fn native_mode(value: &str) -> Option<bool> {
    match value {
        "1" | "functions" => Some(false),
        "queries" => Some(true),
        _ => None,
    }
}

fn native_config() -> Option<&'static NativeConfig> {
    NATIVE_CONFIG.get_or_init(|| {
        let queries = native_mode(&std::env::var("BUN_AOT_NATIVE_TRACE").ok()?)?;
        Some(NativeConfig {
            filter: std::env::var("BUN_AOT_NATIVE_TRACE_FILTER").ok().filter(|s| !s.is_empty()).map(String::into_bytes),
            queries,
        })
    }).as_ref()
}

#[derive(Clone, Copy, Default)]
pub struct NativeCounts {
    pub members: usize,
    pub comparisons: usize,
    pub scanned: usize,
    pub skipped: usize,
    pub provisional: usize,
    pub join_added: usize,
    pub join_merged: bool,
}

#[derive(Clone, Copy)]
struct NativeContext {
    trace: Trace,
    worker: usize,
    body: u64,
    span: u64,
    parent: u64,
    file: u32,
    function: u32,
    ir_function: u32,
    position: u32,
    counts: NativeCounts,
}

thread_local! {
    static NATIVE_CONTEXT: std::cell::Cell<Option<NativeContext>> = const { std::cell::Cell::new(None) };
    static NATIVE_WORKER: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

impl Trace {
    #[inline]
    pub fn native_active() -> bool {
        native_config().is_some_and(|config| config.queries) && NATIVE_CONTEXT.with(|slot| slot.get().is_some())
    }

    pub fn native_function(program: usize, file: u32, function: u32, ir_function: u32, position: u32, path: &[u8]) -> Option<NativeSpan> {
        let config = native_config()?;
        if config.filter.as_ref().is_some_and(|filter| !path.windows(filter.len()).any(|part| part == filter)) {
            return NativeSpan::suspend();
        }
        let log = log()?;
        let trace = Self { log: Some(log), id: 0, program };
        let worker = NATIVE_WORKER.with(|slot| {
            let worker = slot.get().unwrap_or_else(|| log.next.fetch_add(1, Ordering::Relaxed) as usize);
            slot.set(Some(worker));
            worker
        });
        let span = log.next.fetch_add(1, Ordering::Relaxed);
        let context = NativeContext { trace, worker, body: span, span, parent: 0, file, function, ir_function, position, counts: NativeCounts::default() };
        Some(NativeSpan::begin(context, "native_function", None, None, Some(path)))
    }

    pub fn native_query(phase: &'static str, source: u32, target: u32, position: Option<u32>, counts: Option<NativeCounts>) -> Option<NativeSpan> {
        if !native_config()?.queries {
            return None;
        }
        let previous = NATIVE_CONTEXT.with(|slot| slot.get())?;
        let log = previous.trace.log?;
        let context = NativeContext {
            span: log.next.fetch_add(1, Ordering::Relaxed),
            parent: previous.span,
            position: position.unwrap_or(previous.position),
            counts: counts.unwrap_or(previous.counts),
            ..previous
        };
        Some(NativeSpan::begin(context, phase, Some(source), Some(target), None))
    }
}

pub struct NativeSpan {
    context: NativeContext,
    previous: Option<NativeContext>,
    phase: &'static str,
    source: Option<u32>,
    target: Option<u32>,
    started: Instant,
    // Restoring a TLS context must happen on the thread that installed it.
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

impl NativeSpan {
    fn suspend() -> Option<Self> {
        let previous = NATIVE_CONTEXT.with(|slot| slot.replace(None))?;
        let context = NativeContext { trace: Trace { log: None, ..previous.trace }, ..previous };
        Some(Self { context, previous: Some(previous), phase: "filtered", source: None, target: None, started: Instant::now(), _thread: std::marker::PhantomData })
    }

    fn begin(context: NativeContext, phase: &'static str, source: Option<u32>, target: Option<u32>, path: Option<&[u8]>) -> Self {
        let previous = NATIVE_CONTEXT.with(|slot| slot.replace(Some(context)));
        let span = Self { context, previous, phase, source, target, started: Instant::now(), _thread: std::marker::PhantomData };
        // An unbuffered start record identifies the query even if it never returns.
        span.write("start", path);
        span
    }

    pub fn scan(&mut self, known: bool) {
        self.context.counts.scanned += 1;
        self.context.counts.skipped += usize::from(known);
        NATIVE_CONTEXT.with(|slot| slot.set(Some(self.context)));
    }

    pub fn progress(&mut self, members: usize, comparisons: usize, provisional: bool) {
        self.context.counts.members = members;
        self.context.counts.comparisons = comparisons;
        self.context.counts.provisional += usize::from(provisional);
        NATIVE_CONTEXT.with(|slot| slot.set(Some(self.context)));
    }

    fn write(&self, event: &str, path: Option<&[u8]>) {
        if self.context.trace.log.is_none() {
            return;
        }
        let c = self.context;
        let n = c.counts;
        let path = path.map(|path| format!(",\"path_hex\":\"{}\"", hex(path))).unwrap_or_default();
        c.trace.write(format!(
            "\"event\":\"{event}\",\"domain\":\"native_ir\",\"phase\":\"{}\",\"span\":{},\"parent_span\":{},\"body_span\":{},\"worker\":{},\"file\":{},\"function\":{},\"ir_function\":{},\"position\":{},\"source_type\":{},\"target_type\":{},\"members\":{},\"comparisons\":{},\"scanned\":{},\"skipped\":{},\"provisional\":{},\"join_added\":{},\"join_merged\":{},\"elapsed_ns\":{}{}",
            self.phase, c.span, c.parent, c.body, c.worker, c.file, c.function, c.ir_function, c.position,
            optional(self.source), optional(self.target), n.members, n.comparisons, n.scanned, n.skipped,
            n.provisional, n.join_added, n.join_merged,
            if event == "start" { 0 } else { self.started.elapsed().as_nanos() }, path,
        ));
    }
}

impl Drop for NativeSpan {
    fn drop(&mut self) {
        self.write("end", None);
        NATIVE_CONTEXT.with(|slot| slot.set(self.previous));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_trace_byte_limit_defaults_and_validates_bounds() {
        assert_eq!(source_trace_max_bytes(None), Some(256 << 20));
        assert_eq!(source_trace_max_bytes(Some(b"1")), Some(1));
        assert_eq!(source_trace_max_bytes(Some(b"2147483648")), Some(2 << 30));
        for invalid in [b"".as_slice(), b"0", b"-1", b"2147483649", b"18446744073709551616", b"2GiB", b"\xff"] {
            assert_eq!(source_trace_max_bytes(Some(invalid)), None);
        }
    }

    #[test]
    fn native_mode_defaults_to_function_identity_only() {
        assert_eq!(native_mode("1"), Some(false));
        assert_eq!(native_mode("functions"), Some(false));
        assert_eq!(native_mode("queries"), Some(true));
        assert_eq!(native_mode("0"), None);
    }

    fn native_test_context(span: u64) -> NativeContext {
        NativeContext {
            trace: Trace { log: None, id: 0, program: 1 }, worker: 0, body: 1, span, parent: 0,
            file: 7, function: 8, ir_function: 9, position: 10, counts: NativeCounts::default(),
        }
    }

    #[test]
    fn native_nested_spans_restore_parent_identity_and_counts() {
        let before = NATIVE_CONTEXT.with(|slot| slot.replace(None));
        {
            let mut outer = NativeSpan::begin(native_test_context(1), "record_flow_intersections", Some(2), Some(3), None);
            outer.scan(true);
            outer.progress(4, 5, true);
            {
                let parent = NATIVE_CONTEXT.with(|slot| slot.get()).unwrap();
                let _inner = NativeSpan::begin(NativeContext { span: 2, parent: parent.span, ..parent }, "intersection_for_flow_cast", Some(2), Some(3), None);
                assert_eq!(NATIVE_CONTEXT.with(|slot| slot.get()).unwrap().parent, 1);
            }
            let parent = NATIVE_CONTEXT.with(|slot| slot.get()).unwrap();
            assert_eq!(parent.span, 1);
            assert_eq!((parent.counts.scanned, parent.counts.skipped, parent.counts.provisional), (1, 1, 1));
            assert_eq!((parent.counts.members, parent.counts.comparisons), (4, 5));
            {
                let _filtered = NativeSpan::suspend().unwrap();
                assert!(NATIVE_CONTEXT.with(|slot| slot.get()).is_none());
            }
            assert_eq!(NATIVE_CONTEXT.with(|slot| slot.get()).unwrap().span, 1);
        }
        assert!(NATIVE_CONTEXT.with(|slot| slot.get()).is_none());
        NATIVE_CONTEXT.with(|slot| slot.set(before));
    }

    #[test]
    fn path_hex_preserves_invalid_utf8_and_newlines() {
        assert_eq!(hex(b"a\n\"\\\xff"), "610a225cff");
        assert_eq!(optional(None), "null");
        assert_eq!(optional(Some(12)), "12");
    }

    #[test]
    fn write_failure_stops_without_retrying() {
        struct FailingWriter(usize);
        impl std::io::Write for FailingWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                self.0 += 1;
                Err(std::io::Error::other("trace write failure"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut output = Output {
            writer: FailingWriter(0),
            bytes: 0,
            max_bytes: DEFAULT_MAX_BYTES,
            stopped: false,
            phases: HashMap::new(),
        };
        output.write(b"failed record\n");
        output.write(b"not retried\n");
        assert!(output.stopped);
        assert_eq!(output.writer.0, 1);
        assert_eq!(output.bytes, 0);
    }

    #[test]
    fn capped_output_reports_incomplete_once() {
        let mut output = Output {
            writer: Vec::new(),
            bytes: DEFAULT_MAX_BYTES - 1,
            max_bytes: DEFAULT_MAX_BYTES,
            stopped: false,
            phases: HashMap::new(),
        };
        output.write(b"too long\n");
        output.write(b"never written\n");
        assert_eq!(
            output.writer,
            b"{\"event\":\"trace_limit\",\"complete\":false}\n"
        );
        assert!(output.stopped);
    }
}
