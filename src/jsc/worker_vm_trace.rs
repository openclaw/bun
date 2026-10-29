//! Opt-in, process-owned Worker VM lifecycle trace. No user data is recorded.

use std::sync::OnceLock;

use bun_core::Mutex;

static TRACE: OnceLock<Mutex<Trace>> = OnceLock::new();

struct Trace {
    file: bun_sys::File,
    path: Vec<u8>,
    spawned: u64,
    started: u64,
    published: u64,
    destroyed: u64,
    ended: u64,
    closed: bool,
}

pub(crate) enum Event {
    ThreadSpawned,
    ThreadStart,
    VmPublished,
    VmDestroyed,
    ThreadEnd,
}

impl Event {
    fn name(&self) -> &'static str {
        match self {
            Self::ThreadSpawned => "thread-spawned",
            Self::ThreadStart => "thread-start",
            Self::VmPublished => "vm-published",
            Self::VmDestroyed => "vm-destroyed",
            Self::ThreadEnd => "thread-end",
        }
    }
}

/// Called once at process entry, before CLI dispatch or user code.
pub fn init() {
    let Some(path) = bun_core::env_var::BUN_WORKER_VM_TRACE.get() else {
        return;
    };
    if !bun_paths::is_absolute(path) {
        bun_core::Output::err_generic(
            "BUN_WORKER_VM_TRACE requires an absolute path, got <b>{}<r>",
            (bstr::BStr::new(path),),
        );
        bun_core::Global::exit(1);
    }

    let pid = std::process::id().to_string();
    let mut final_path = Vec::with_capacity(path.len() + pid.len());
    let mut rest = path;
    while let Some(at) = bun_core::strings::index_of(rest, b"%p") {
        final_path.extend_from_slice(&rest[..at]);
        final_path.extend_from_slice(pid.as_bytes());
        rest = &rest[at + 2..];
    }
    final_path.extend_from_slice(rest);

    let file = bun_sys::File::openat(
        bun_sys::Fd::cwd(),
        &final_path,
        bun_sys::O::WRONLY | bun_sys::O::CREAT | bun_sys::O::EXCL | bun_sys::O::CLOEXEC,
        0o600,
    )
    .unwrap_or_else(|err| fail(err, &final_path));
    let mut trace = Trace {
        file,
        path: final_path,
        spawned: 0,
        started: 0,
        published: 0,
        destroyed: 0,
        ended: 0,
        closed: false,
    };
    trace
        .write(&format!(
            "{{\"version\":1,\"event\":\"trace-ready\",\"pid\":{},\"parentPid\":{},\"nativeTid\":{}}}\n",
            std::process::id(),
            bun_io::ParentDeathWatchdog::parent_pid(),
            bun_core::thread_id::current(),
        ))
        .unwrap_or_else(|err| fail(err, &trace.path));
    TRACE.get_or_init(|| Mutex::new(trace));
    bun_core::Global::add_exit_callback(finish);
}

impl Trace {
    fn write(&mut self, line: &str) -> bun_sys::Maybe<()> {
        // Hold the process mutex through partial writes so each JSONL record stays intact.
        let mut bytes = line.as_bytes();
        while !bytes.is_empty() {
            let written = bun_sys::write(self.file.handle(), bytes)?;
            if written == 0 {
                return Err(bun_sys::Error::from_code(
                    bun_sys::E::EIO,
                    bun_sys::Tag::write,
                ));
            }
            bytes = &bytes[written..];
        }
        Ok(())
    }
}

pub(crate) fn record(event: Event, context_id: u32, parent_context_id: u32) {
    let Some(trace) = TRACE.get() else {
        return;
    };
    let line = format!(
        "{{\"version\":1,\"event\":\"{}\",\"pid\":{},\"nativeTid\":{},\"contextId\":{},\"parentContextId\":{}}}\n",
        event.name(),
        std::process::id(),
        bun_core::thread_id::current(),
        context_id,
        parent_context_id,
    );
    let mut trace = trace.lock();
    if trace.closed {
        return;
    }
    if let Err(err) = trace.write(&line) {
        trace.closed = true;
        let path = trace.path.clone();
        drop(trace);
        fail(err, &path);
    }
    match event {
        Event::ThreadSpawned => trace.spawned += 1,
        Event::ThreadStart => trace.started += 1,
        Event::VmPublished => trace.published += 1,
        Event::VmDestroyed => trace.destroyed += 1,
        Event::ThreadEnd => trace.ended += 1,
    }
}

extern "C" fn finish() {
    let Some(trace) = TRACE.get() else {
        return;
    };
    let mut trace = trace.lock();
    if trace.closed {
        return;
    }
    // Process exit may skip Worker teardown. Keep that capture explicitly incomplete.
    let complete = u8::from(
        trace.spawned == trace.started
            && trace.started == trace.ended
            && trace.published == trace.destroyed,
    );
    let line = format!(
        "{{\"version\":1,\"event\":\"trace-end\",\"pid\":{},\"nativeTid\":{},\"spawned\":{},\"started\":{},\"published\":{},\"destroyed\":{},\"ended\":{},\"complete\":{}}}\n",
        std::process::id(),
        bun_core::thread_id::current(),
        trace.spawned,
        trace.started,
        trace.published,
        trace.destroyed,
        trace.ended,
        complete,
    );
    trace.closed = true;
    if let Err(err) = trace.write(&line) {
        let path = trace.path.clone();
        drop(trace);
        fail(err, &path);
    }
}

fn fail(err: bun_sys::Error, path: &[u8]) -> ! {
    bun_core::Output::err(
        err,
        "BUN_WORKER_VM_TRACE failed for <b>{}<r>; use a new writable file path",
        (bstr::BStr::new(path),),
    );
    bun_core::Global::exit(1)
}
