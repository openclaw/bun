// Build scripts run on the host before bun_* crates are compiled; std is the only option.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    clippy::disallowed_macros
)]
//! Set BUN_CODEGEN_DIR for `include!(concat!(env!("BUN_CODEGEN_DIR"), "/cpp.rs"))`.
//!
//! The codegen output lives at `<repo>/build/<profile>/codegen/` and is produced by
//! `src/codegen/cppbind.ts` (run as part of `bun bd`). This build script just
//! resolves and exports the path; it does NOT run the generator (that would
//! create a Bun→cargo→Bun bootstrap loop).
//!
//! Mirrors `src/runtime/build.rs` so `cargo check -p bun_jsc` (and `--workspace`)
//! works without a manually-exported `BUN_CODEGEN_DIR`.

use std::env;
use std::path::{Path, PathBuf};

fn main() {
    // src/jsc → repo root is two up.
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo = manifest
        .parent()
        .and_then(Path::parent)
        .expect("repo root from CARGO_MANIFEST_DIR")
        .to_path_buf();

    // Allow override; default to debug profile codegen dir.
    let codegen_dir = env::var("BUN_CODEGEN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo.join("build/debug/codegen"));

    println!("cargo:rustc-check-cfg=cfg(jsc_short_function_executable)");
    let type_header = codegen_dir.parent().unwrap().join("deps/WebKit/JavaScriptCore/PrivateHeaders/JavaScriptCore/JSType.h");
    if type_header.exists() {
        println!("cargo:rerun-if-changed={}", type_header.display());
        let source = std::fs::read_to_string(&type_header).expect("read local WebKit JSType layout");
        if source.contains("macro(ShortFunctionExecutableType,") {
            println!("cargo:rustc-cfg=jsc_short_function_executable");
        }
    }

    let cpp_rs = codegen_dir.join("cpp.rs");
    if !cpp_rs.exists() {
        panic!(
            "cpp.rs not found at {} — run `bun src/codegen/cppbind.ts` (or `bun bd`) first",
            cpp_rs.display()
        );
    }

    println!(
        "cargo:rerun-if-changed={}",
        codegen_dir
            .join("generated_builtin_module_key_index.rs")
            .display()
    );
    let resolved_source_tag_rs = codegen_dir.join("generated_resolved_source_tag.rs");
    if !resolved_source_tag_rs.exists() {
        panic!(
            "generated_resolved_source_tag.rs not found at {} — run `bun bd` (bundle-modules codegen) first",
            resolved_source_tag_rs.display()
        );
    }

    let error_code_rs = codegen_dir.join("ErrorCode.generated.rs");
    if !error_code_rs.exists() {
        panic!(
            "ErrorCode.generated.rs not found at {} — run `bun bd` (generate-node-errors codegen) first",
            error_code_rs.display()
        );
    }

    println!("cargo:rustc-env=BUN_CODEGEN_DIR={}", codegen_dir.display());
    println!("cargo:rerun-if-changed={}", cpp_rs.display());
    println!(
        "cargo:rerun-if-changed={}",
        resolved_source_tag_rs.display()
    );
    println!("cargo:rerun-if-changed={}", error_code_rs.display());
    println!("cargo:rerun-if-env-changed=BUN_CODEGEN_DIR");
}
