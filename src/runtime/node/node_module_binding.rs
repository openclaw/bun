//! Native backing for `module.stripTypeScriptTypes` (`node:module`).
//! Returns the blanked source, or `{ errorCode, message, startLine, snippet }` for the JS
//! wrapper to throw; see https://github.com/nodejs/node/blob/main/lib/internal/modules/typescript.js

use bun_alloc::Arena;
use bun_ast::Loader;
use bun_core::String as BunString;
use bun_jsc::{self as jsc, CallFrame, JSGlobalObject, JSValue, JsResult, StringJsc as _};

/// 1-based line number of byte offset `lo`, and the source text of that line
/// (for Node's `filename:line\n<snippet>` error-stack decoration).
fn line_and_snippet(source: &[u8], lo: u32, hi: u32) -> (u32, Vec<u8>) {
    let lo = (lo as usize).min(source.len());
    let hi = (hi as usize).min(source.len()).max(lo);
    let line_start =
        bun_core::strings::last_index_of_char(&source[..lo], b'\n').map_or(0, |i| i + 1);
    let line_end = bun_core::strings::index_of_char_usize(&source[lo..], b'\n')
        .map_or(source.len(), |i| lo + i);
    let line_no = 1 + bun_core::strings::count_char(&source[..lo], b'\n') as u32;

    // `<line>\n<caret marks under the offending span>` like amaro's
    // diagnostic snippet (clamped to the first line of the construct).
    let mut snippet = source[line_start..line_end].to_vec();
    snippet.push(b'\n');
    for i in line_start..line_end {
        snippet.push(if i >= lo && i < hi { b'^' } else { b' ' });
    }
    while snippet.last() == Some(&b' ') {
        snippet.pop();
    }
    (line_no, snippet)
}

fn error_object(
    global: &JSGlobalObject,
    error_code: &str,
    message: &[u8],
    line: u32,
    snippet: &[u8],
) -> JsResult<JSValue> {
    let obj = JSValue::create_empty_object_with_null_prototype(global);
    obj.put(
        global,
        "errorCode",
        jsc::bun_string_jsc::create_utf8_for_js(global, error_code.as_bytes())?,
    );
    obj.put(
        global,
        "message",
        jsc::bun_string_jsc::create_utf8_for_js(global, message)?,
    );
    obj.put(
        global,
        "startLine",
        JSValue::js_number_from_int32(line as i32),
    );
    obj.put(
        global,
        "snippet",
        jsc::bun_string_jsc::create_utf8_for_js(global, snippet)?,
    );
    Ok(obj)
}

/// `stripTypeScriptTypesNative(code)` — parse `code` as TypeScript and blank
/// every type-only span in place (amaro's strip-only mode).
#[bun_jsc::host_fn]
pub(crate) fn strip_type_script_types_native(
    global: &JSGlobalObject,
    frame: &CallFrame,
) -> JsResult<JSValue> {
    let code = frame.argument(0);
    let code_view = code.to_js_string_view(global)?;
    // Node passes well-formed UTF-8 to amaro; Bun's usual conversion preserves lone surrogates as WTF-8.
    let code_bytes = if code_view.is_utf16() {
        bun_core::Utf8Bytes::Owned(
            std::string::String::from_utf16_lossy(code_view.utf16()).into_bytes(),
        )
    } else {
        code_view.to_utf8()
    };
    let code_utf8 = code_bytes.as_ref();
    let arena = Arena::new();
    let mut ast_memory_allocator = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _ast_scope = ast_memory_allocator.enter();
    let source = bun_ast::Source::init_path_string(Loader::Ts.stdin_name(), code_utf8);
    let define = bun_js_parser::Define::default();
    let mut log = bun_ast::Log::init();
    let mut options = bun_js_parser::ParserOptions::init(Default::default(), Loader::Ts);
    options.features.no_macros = true;
    options.features.top_level_await = true;
    options.features.lower_using = false;
    let parse_result = bun_js_parser::Parser::init(options, &mut log, &source, &define, &arena)
        .and_then(bun_js_parser::Parser::strip_types);

    if log.errors > 0 {
        // amaro maps parser errors to `InvalidSyntax`; the message text comes
        // from Bun's parser.
        let msg = log
            .msgs
            .iter()
            .find(|m| matches!(m.kind, bun_ast::Kind::Err));
        let text: &[u8] = msg.map(|m| m.data.text.as_ref()).unwrap_or(b"Syntax error");
        let lo = msg
            .and_then(|m| m.data.location.as_ref())
            .map(|l| l.offset as u32)
            .unwrap_or(0);
        let (line, snippet) = line_and_snippet(code_utf8, lo, lo + 1);
        return error_object(global, "InvalidSyntax", text, line, &snippet);
    }
    let Ok(parse_result) = parse_result else {
        let (line, snippet) = line_and_snippet(code_utf8, 0, 1);
        return error_object(global, "InvalidSyntax", b"Syntax error", line, &snippet);
    };

    match parse_result {
        bun_js_parser::ts_strip::Output::Code(out) => BunString::clone_utf8(&out).into_js(global),
        bun_js_parser::ts_strip::Output::Unsupported { message, lo, hi } => {
            let (line, snippet) = line_and_snippet(code_utf8, lo, hi);
            error_object(
                global,
                "UnsupportedSyntax",
                message.as_bytes(),
                line,
                &snippet,
            )
        }
    }
}
