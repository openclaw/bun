//! Opt-in capture of the exact inputs passed to JSC's typed-program compiler.

use core::sync::atomic::{AtomicU64, Ordering};

use bun_sys::{Fd, File, O};

static NEXT_CAPTURE: AtomicU64 = AtomicU64::new(1);

pub(crate) struct Capture {
    directory: File,
    path: Box<[u8]>,
    pid: u32,
    sequence: u64,
    stem: String,
    ir_bytes: usize,
    ir_sha256: String,
}

impl Capture {
    pub(crate) fn start(program: &[u8]) -> Result<Option<Self>, String> {
        let Some(path) = bun_core::env_var::BUN_AOT_NATIVE_IR_EXPORT.get() else {
            return Ok(None);
        };
        if !bun_paths::is_absolute(path) || path.contains(&0) {
            return Err("BUN_AOT_NATIVE_IR_EXPORT must name an existing absolute directory".into());
        }
        let directory = File::openat(Fd::cwd(), path, O::RDONLY | O::DIRECTORY | O::CLOEXEC, 0)
            .map_err(|error| {
                format!(
                    "cannot open BUN_AOT_NATIVE_IR_EXPORT directory {:?}: {error}",
                    bstr::BStr::new(path)
                )
            })?;
        let pid = std::process::id();
        // This only reserves a filename; it does not publish any capture state.
        let sequence = NEXT_CAPTURE.fetch_add(1, Ordering::Relaxed);
        let capture = Self {
            directory,
            path: path.into(),
            pid,
            sequence,
            stem: format!("{pid}-{sequence}"),
            ir_bytes: program.len(),
            ir_sha256: sha256(program),
        };
        capture.write("ir", program)?;
        Ok(Some(capture))
    }

    pub(crate) fn replacements(self, strings: &[u8]) -> Result<(), String> {
        self.write("replacements", strings)?;
        // A receipt describes captured compiler inputs, not successful optimization or emitted code.
        let receipt = format!(
            "{{\"version\":1,\"pid\":{},\"sequence\":{},\"phase\":\"before-optimize\",\"complete\":true,\"ir\":{{\"file\":\"{}.ir\",\"bytes\":{},\"sha256\":\"{}\"}},\"replacements\":{{\"file\":\"{}.replacements\",\"bytes\":{},\"sha256\":\"{}\"}}}}\n",
            self.pid,
            self.sequence,
            self.stem,
            self.ir_bytes,
            self.ir_sha256,
            self.stem,
            strings.len(),
            sha256(strings),
        );
        self.write("json", receipt.as_bytes())
    }

    fn write(&self, extension: &str, mut bytes: &[u8]) -> Result<(), String> {
        let name = format!("{}.{extension}", self.stem);
        let result = (|| {
            let file = File::openat(
                self.directory.fd(),
                name.as_bytes(),
                O::WRONLY | O::CREAT | O::EXCL | O::CLOEXEC,
                0o600,
            )?;
            while !bytes.is_empty() {
                let written = bun_sys::write(file.fd(), bytes)?;
                if written == 0 {
                    return Err(bun_sys::Error::from_code(
                        bun_sys::E::EIO,
                        bun_sys::Tag::write,
                    ));
                }
                bytes = &bytes[written..];
            }
            bun_sys::close(file.into_raw())
        })();
        result.map_err(|error| {
            format!(
                "cannot write BUN_AOT_NATIVE_IR_EXPORT capture {:?}/{name}: {error}",
                bstr::BStr::new(&self.path),
            )
        })
    }
}

fn sha256(bytes: &[u8]) -> String {
    let mut digest = [0; 32];
    // SAFETY: `digest` has the 32 bytes SHA256 writes; `bytes` lives for the call.
    unsafe { bun_boringssl::c::SHA256(bytes.as_ptr(), bytes.len(), digest.as_mut_ptr()) };
    bun_core::fmt::bytes_to_hex_lower_string(&digest)
}
