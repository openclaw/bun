//! Native bindings for `internal/modules/customization_hooks.ts`
//! (`module.registerHooks()`).

use bun_jsc::bun_string_jsc::StringJsc;
use bun_jsc::virtual_machine::ResolveMode;
use bun_jsc::{CallFrame, JSGlobalObject, JSValue, JsResult};

/// `setModuleHooksCounts(resolveCount, loadCount)` — mirrors the JS-side hook
/// counts into the `VirtualMachine`; loadCount includes pending resolve results
/// so deregistration cannot discard an in-flight module's format or attributes.
#[bun_jsc::host_fn]
pub(crate) fn set_module_hooks_counts(
    global: &JSGlobalObject,
    frame: &CallFrame,
) -> JsResult<JSValue> {
    let resolve_count = frame.argument(0).to_int32();
    let load_count = frame.argument(1).to_int32();
    let vm = global.bun_vm_ptr();
    // SAFETY: per-thread VM is live (host functions run on the JS thread).
    unsafe {
        (*vm).module_hooks_resolve_count = resolve_count.max(0) as u32;
        (*vm).module_hooks_load_count = load_count.max(0) as u32;
        if resolve_count > 0 || load_count > 0 {
            (*vm).module_hooks_ever_registered = true;
            (*vm).transpiler.resolver.runtime_mutable_directories = true;
        }
    }
    Ok(JSValue::UNDEFINED)
}

#[bun_jsc::host_fn]
pub(crate) fn get_builtin_specifier_for_hooks(
    global: &JSGlobalObject,
    frame: &CallFrame,
) -> JsResult<JSValue> {
    let name = frame.argument(0).to_utf8(global)?;
    if bun_jsc::module_loader::exposed_internal_tag(name.slice()).is_some() {
        return bun_jsc::bun_string_jsc::create_utf8_for_js(global, name.slice());
    }
    if let Some(alias) = bun_jsc::module_loader::bun_aliases_get(name.slice()) {
        return bun_jsc::bun_string_jsc::create_utf8_for_js(global, alias.path.as_bytes());
    }
    if bun_jsc::module_loader::HardcodedModule::HardcodedModule::MAP.contains_key(name.slice()) {
        return bun_jsc::bun_string_jsc::create_utf8_for_js(global, name.slice());
    }
    Ok(JSValue::UNDEFINED)
}

#[bun_jsc::host_fn]
pub(crate) fn get_default_conditions_for_hooks(
    global: &JSGlobalObject,
    frame: &CallFrame,
) -> JsResult<JSValue> {
    let is_esm = frame.argument(0).is_truthy();
    let vm = global.bun_vm();
    let map = if is_esm {
        &vm.transpiler.resolver.opts.conditions.import
    } else {
        &vm.transpiler.resolver.opts.conditions.require
    };
    let defaults: &[&[u8]] = if is_esm {
        &[b"node", b"import", b"module-sync", b"node-addons"]
    } else {
        &[b"require", b"node", b"node-addons", b"module-sync"]
    };
    let mut conditions: Vec<Box<[u8]>> = defaults
        .iter()
        .filter(|condition| map.contains(condition))
        .map(|condition| (*condition).into())
        .collect();
    if map.contains(b"bun") {
        conditions.push(b"bun".as_slice().into());
    }
    for condition in &vm.transpiler.options.transform_options.conditions {
        if is_esm || !conditions.contains(condition) {
            conditions.push(condition.clone());
        }
    }
    JSValue::create_array_from_iter(global, conditions.into_iter(), |condition| {
        bun_jsc::bun_string_jsc::create_utf8_for_js(global, &condition)
    })
}

#[bun_jsc::host_fn]
pub(crate) fn default_resolve_for_hooks(
    global: &JSGlobalObject,
    frame: &CallFrame,
) -> JsResult<JSValue> {
    let specifier = frame.argument(0).to_bun_string(global)?;
    let referrer = frame.argument(1).to_bun_string(global)?;
    let is_esm = frame.argument(2).is_truthy();
    let is_user_require_resolve = frame.argument(3).is_truthy();
    let conditions = frame.argument(4);
    let mut condition_map = None;
    if conditions.is_array() {
        let mut map = bun_resolver::package_json::ConditionsMap::default();
        map.insert(b"default", ());
        for index in 0..conditions.get_length(global)? {
            let value = conditions.get_index(global, index as u32)?;
            if value.is_string() {
                let condition = value.to_utf8(global)?;
                map.insert(condition.slice(), ());
            }
        }
        condition_map = Some(map);
    }

    let vm = global.bun_vm_ptr();
    // SAFETY: only this JS thread uses the VM; no field borrow spans resolution.
    let previous_skip = unsafe { core::mem::replace(&mut (*vm).module_hooks_skip, true) };
    let previous_conditions = condition_map.map(|map| {
        // SAFETY: the old map is restored before returning, including exceptions.
        unsafe {
            let slot = if is_esm {
                &mut (*vm).transpiler.resolver.opts.conditions.import
            } else {
                &mut (*vm).transpiler.resolver.opts.conditions.require
            };
            core::mem::replace(slot, map)
        }
    });
    scopeguard::defer! {
        // SAFETY: the synchronous native resolution has returned on this JS thread.
        unsafe {
            (*vm).module_hooks_skip = previous_skip;
            if let Some(map) = previous_conditions {
                let slot = if is_esm {
                    &mut (*vm).transpiler.resolver.opts.conditions.import
                } else {
                    &mut (*vm).transpiler.resolver.opts.conditions.require
                };
                *slot = map;
            }
        }
    }

    if frame.argument(5).is_truthy() {
        // Resolve the installed package without the VM's replacement aliases.
        let parent = if referrer.starts_with_ascii(b"file:") {
            bun_url::path_from_file_url(&referrer)
        } else {
            referrer
        };
        let parent = parent.to_utf8();
        let name = specifier.to_utf8();
        let resolver_vm = global.bun_vm_ptr();
        // SAFETY: this synchronous resolver call cannot execute JavaScript;
        // its options are restored before returning to the hook chain.
        let resolved = unsafe {
            let resolver = &mut (*resolver_vm).transpiler.resolver;
            let old_target = core::mem::replace(&mut resolver.opts.target, bun_ast::Target::Node);
            let old_fields = core::mem::replace(
                &mut resolver.opts.main_fields,
                vec![b"main".as_slice().into()].into_boxed_slice(),
            );
            let old_default = core::mem::replace(&mut resolver.opts.main_fields_is_default, false);
            let old_tsconfig = core::mem::replace(&mut resolver.ignore_tsconfig_paths, true);
            let result = resolver.resolve(
                bun_resolver::fs::PathName::init(parent.slice()).dir,
                name.slice(),
                if is_esm {
                    bun_ast::ImportKind::Stmt
                } else {
                    bun_ast::ImportKind::Require
                },
            );
            resolver.opts.target = old_target;
            resolver.opts.main_fields = old_fields;
            resolver.opts.main_fields_is_default = old_default;
            resolver.ignore_tsconfig_paths = old_tsconfig;
            result
                .ok()
                .and_then(|result| result.path_const().map(|path| path.text.to_vec()))
        };
        if let Some(path) = resolved.filter(|path| bun_paths::is_absolute(path)) {
            return bun_url::file_url_from_string(&bun_core::String::clone_utf8(&path))
                .into_js(global);
        }
        return Ok(JSValue::UNDEFINED);
    }

    crate::api::bun_object::resolve_for_module_hooks(
        global,
        &specifier,
        &referrer,
        ResolveMode::from_ffi_bools(is_esm, is_user_require_resolve),
    )
}

#[bun_jsc::host_fn]
pub(crate) fn get_package_type_for_hooks(
    global: &JSGlobalObject,
    frame: &CallFrame,
) -> JsResult<JSValue> {
    let filename = frame.argument(0).to_utf8(global)?;
    let dir = bun_resolver::fs::PathName::init(filename.slice()).dir;
    let vm = global.bun_vm_ptr();
    // SAFETY: the resolver belongs to the live VM on its JS thread.
    let package = unsafe { (*vm).transpiler.resolver.read_dir_info(dir) }
        .ok()
        .flatten()
        .and_then(|info| info.package_json_for_node_scope());
    let kind = match package.map(|package| package.module_type) {
        Some(bun_options_types::bundle_enums::ModuleType::Cjs) => 1,
        Some(bun_options_types::bundle_enums::ModuleType::Esm) => 2,
        _ => 0,
    };
    Ok(JSValue::js_number_from_int32(kind))
}
