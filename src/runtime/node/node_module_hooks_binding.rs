//! Native bindings for `internal/modules/customization_hooks.ts`
//! (`module.registerHooks()`).

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
        .and_then(|info| info.package_json().or(info.enclosing_package_json));
    let kind = match package.map(|package| package.module_type) {
        Some(bun_options_types::bundle_enums::ModuleType::Cjs) => 1,
        Some(bun_options_types::bundle_enums::ModuleType::Esm) => 2,
        _ => 0,
    };
    Ok(JSValue::js_number_from_int32(kind))
}
