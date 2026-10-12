use bun_bundler::options::{OutputFile, OutputKind, Side};
use bun_core::String as BunString;
use bun_options_types::bundle_enums::Format;

#[repr(C)]
struct Source {
    source: BunString,
    name: BunString,
    graph_index: u32,
}

unsafe extern "C" {
    fn Bun__buildAOTImage(
        sources: *const Source,
        count: usize,
        is_module: bool,
        graph: *const u8,
        graph_len: usize,
        table: *const u8,
        table_len: usize,
        slots: *const u8,
        slots_len: usize,
        context: *mut core::ffi::c_void,
        append: extern "C" fn(*mut core::ffi::c_void, *const u8, usize),
    ) -> bool;
    fn Bun__destroyBytecodeCacheVM();
}

pub(super) fn build(
    files: &[OutputFile],
    prefix: &[u8],
    format: Format,
) -> Result<Vec<u8>, String> {
    bun_jsc::initialize(Default::default());
    let mut sources = Vec::new();
    let mut names = bun_collections::StringArrayHashMap::<()>::new();
    for file in files {
        if !file.output_kind.is_file_in_standalone_mode()
            || !file.loader.is_javascript_like()
            || file.side == Some(Side::Client)
        {
            continue;
        }
        let path = bun_core::strings::remove_leading_dot_slash(&file.dest_path);
        if names
            .get_or_put(path)
            .map_err(|e| e.to_string())?
            .found_existing
        {
            continue;
        }
        let mut name = prefix.to_vec();
        name.extend_from_slice(path);
        sources.push(Source {
            source: BunString::clone_utf8(file.value.as_slice()),
            name: BunString::clone_utf8(&name),
            graph_index: file.prelinked_module_index,
        });
    }
    let bytes = |kind| {
        files
            .iter()
            .find(|f| f.output_kind == kind)
            .map_or(&[][..], |f| f.value.as_slice())
    };
    let graph = bytes(OutputKind::PrelinkedModuleGraph);
    let table = bytes(OutputKind::BytecodeStringTable);
    let slots = bytes(OutputKind::ModuleInfoStringTable);
    let mut image = Vec::<u8>::new();
    extern "C" fn append(context: *mut core::ffi::c_void, ptr: *const u8, len: usize) {
        // SAFETY: synchronous callback borrows this build's Vec and C++'s live byte span.
        unsafe {
            (&mut *context.cast::<Vec<u8>>())
                .extend_from_slice(core::slice::from_raw_parts(ptr, len));
        }
    }
    // SAFETY: all source strings and blobs outlive the synchronous C++ compiler and callback.
    let ok = unsafe {
        Bun__buildAOTImage(
            sources.as_ptr(),
            sources.len(),
            format == Format::Esm,
            graph.as_ptr(),
            graph.len(),
            table.as_ptr(),
            table.len(),
            slots.as_ptr(),
            slots.len(),
            (&raw mut image).cast(),
            append,
        )
    };
    // SAFETY: no encoder or sources in the bytecode VM survive the synchronous compiler.
    unsafe {
        Bun__destroyBytecodeCacheVM();
    }
    if !ok || image.is_empty() {
        return Err("JavaScriptCore could not compile the standalone module graph".into());
    }
    bun_core::pretty_errorln!(
        "AOT: compiled {} modules into {} bytes",
        sources.len(),
        image.len()
    );
    Ok(image)
}
