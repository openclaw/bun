//! Opt-in source-search timing. Detailed start records survive a query that never returns.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const MAX_BYTES: usize = 256 << 20;
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
    stopped: bool,
    phases: HashMap<(usize, usize), (u64, &'static str)>,
}

impl<W: std::io::Write> Output<W> {
    fn write(&mut self, line: &[u8]) {
        if self.stopped {
            return;
        }
        if self.bytes + line.len() > MAX_BYTES {
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

fn log() -> Option<&'static Log> {
    LOG.get_or_init(|| {
        let path = std::env::var_os("BUN_AOT_SOURCE_TRACE")?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
            bytes: MAX_BYTES - 1,
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
