//! UpgradedDuplex provides TLS/SSL encryption for Node.js-style duplex streams.
//!
//! This is used when you need to add TLS encryption to streams that are not traditional
//! network sockets. In Node.js, you can have duplex streams that represent arbitrary
//! read/write channels - these could be in-memory streams, custom transport protocols,
//! or any other bidirectional data flow that implements the duplex stream interface.
//!
//! Since these duplex streams don't have native SSL support (they're not actual socket
//! file descriptors),
//!
//! The duplex stream manages the SSL handshake, certificate validation, encryption/decryption,
//! and integrates with Bun's event loop for timeouts and async operations. It maintains
//! JavaScript callbacks for handling connection events and errors.

use core::cell::Cell;
use core::ffi::{CStr, c_uint, c_void};

use bun_jsc::bindgen::{JsLocal, JsScope};
use bun_jsc::virtual_machine::VirtualMachine;
use bun_jsc::{GlobalRef, JSGlobalObject, JSValue, JsCell, JsResult, host_fn};
use bun_uws::{us_bun_verify_error_t, uws_callback};

use super::DuplexUpgradeContext;
use super::ssl_wrapper::SSLWrapper;
use crate::generated_bindgen::socket_body::js_TLSSocket;
use crate::generated_bindgen::upgraded_duplex::{self as listeners, DuplexChunk};
use crate::timer::{ElTimespec, EventLoopTimer, EventLoopTimerState, EventLoopTimerTag};

bun_output::declare_scope!(UpgradedDuplex, visible);

pub(crate) struct UpgradedDuplex {
    pub wrapper: JsCell<Option<WrapperType>>,
    /// The owning `JSTLSSocket` wrapper. Its `internalFields` root `origin` and
    /// the listener and completion thunks; the `JSValue` fields below are read-side
    /// shadows of those slots.
    pub js_wrapper: JSValue,
    pub origin: Cell<JSValue>, // any duplex
    // JSC_BORROW per LIFETIMES.tsv.
    pub global: Option<GlobalRef>,
    pub ssl_error: JsCell<CertError>,
    // JSC_BORROW per LIFETIMES.tsv. `Option` so the struct is zero-initializable
    // (socket_body.rs `DuplexUpgradeContext` two-phase init builds this field as
    // `zeroed()` before overwriting via `from()`).
    pub vm: Option<&'static VirtualMachine>,
    pub handlers: Handlers,
    pub on_data_callback: Cell<JSValue>,
    pub on_end_callback: Cell<JSValue>,
    pub on_writable_callback: Cell<JSValue>,
    pub on_close_callback: Cell<JSValue>,
    on_write_callback: Cell<JSValue>,
    on_write_dispatch: Cell<JSValue>,
    on_close_dispatch: Cell<JSValue>,
    pending_writes: Cell<usize>,
    shutdown_queued: Cell<bool>,
    write_failed: Cell<bool>,
    transport_call_depth: Cell<usize>,
    context: bun_jsc::ContextId,
    pub event_loop_timer: JsCell<EventLoopTimer>,
    pub current_timeout: Cell<u32>,
    /// Transport bytes that arrived before the TLS engine existed.
    ///
    /// `upgrade_duplex_to_tls` defers `start_tls` to an event-loop task (so
    /// `on_open` cannot re-enter JS before the caller holds the handle), but the
    /// JS caller attaches its `data` listener as soon as that function returns.
    /// When both ends of a `duplexPair()` are wrapped in-process, the peer's
    /// engine starts first and writes its ClientHello while this side's
    /// `wrapper` is still `None`. Dropping those bytes deadlocks the handshake
    /// forever, so stage them here and replay them from
    /// [`Self::drain_pending`] as soon as the engine is up.
    pub pending_data: JsCell<Vec<u8>>,
    /// The transport closed before the TLS engine existed (same window as
    /// [`Self::pending_data`]). Consumed by the queued `StartTLS` task.
    pub pending_close: Cell<bool>,
    /// [`Self::shutdown`] arrived before the engine existed. [`Self::drain_pending`] replays it.
    pub pending_shutdown: Cell<bool>,
    /// `pause_stream` paused the wrapped stream and `resume_stream` has not run since.
    paused_origin: Cell<bool>,
    /// Socket shutdown can still be draining queued ciphertext after `end()`.
    is_node_socket: bool,
}

bun_event_loop::impl_timer_owner!(UpgradedDuplex; from_timer_ptr => event_loop_timer);

#[derive(Default)]
pub(crate) struct CertError {
    pub(crate) error_no: i32,
    // Owned NUL-terminated copies. `None` represents the default `""`.
    pub(crate) code: Option<Box<CStr>>,
    pub reason: Option<Box<CStr>>,
}
// `Box<CStr>` drops automatically — no explicit Drop needed.

type WrapperType = SSLWrapper<*mut UpgradedDuplex>;

/// Server-side peer-certificate policy for a duplex TLS upgrade, resolved in
/// `upgrade_duplex_to_tls` and applied via `SSLWrapper::set_server_verify`.
/// Ignored for client upgrades.
#[derive(Clone, Copy)]
pub(crate) struct ServerVerify {
    /// `requestCert` — whether to send a CertificateRequest at all.
    pub request_cert: bool,
    /// `rejectUnauthorized` — only meaningful when `request_cert` is set.
    pub reject_unauthorized: bool,
}

pub(crate) struct Handlers {
    // BACKREF per LIFETIMES.tsv — container holding self as `.upgrade`.
    pub ctx: *mut (),
    pub(crate) on_open: fn(*mut ()),
    pub(crate) on_handshake: fn(*mut (), bool, us_bun_verify_error_t),
    pub(crate) on_data: fn(*mut (), &[u8]),
    pub on_close: fn(*mut ()),
    pub(crate) on_end: fn(*mut ()),
    pub(crate) on_writable: fn(*mut ()),
    pub(crate) on_error: fn(*mut (), JSValue),
    pub(crate) on_timeout: fn(*mut ()),
    /// A new resumable TLS session (serialized SSL_SESSION) - node's
    /// `'session'` event on the wrapping TLSSocket.
    pub(crate) on_session: fn(*mut (), &[u8]),
    /// An NSS key-log line - node's `'keylog'` event.
    pub(crate) on_keylog: fn(*mut (), &[u8]),
    pub(crate) server_identity:
        fn(*mut (), &mut bun_boringssl_sys::SSL) -> bun_boringssl::ServerIdentity,
}

use crate::jsc_hooks::timer_all_mut as timer_all;

/// Lazily create-and-cache a JS host-function callback in `shadow`, mirrored
/// into the owning `JSTLSSocket` wrapper's visited internal field (the GC
/// root). A bound callback traces the owner; the unbound target remains in
/// the shadow so live teardown can neuter it before freeing native storage.
#[inline]
fn lazy_js_handler(
    shadow: &Cell<JSValue>,
    js_wrapper: JSValue,
    get_slot: fn(JSValue) -> Option<JSValue>,
    set_slot: fn(JSValue, &JSGlobalObject, JSValue),
    global: &JSGlobalObject,
    func: host_fn::JSHostFn,
    this_ptr: *mut c_void,
) -> JsResult<JSValue> {
    if !shadow.get().is_empty() {
        return Ok(get_slot(js_wrapper).expect("cached duplex callback"));
    }
    let callback = host_fn::new_function_with_data(global, None, 0, func, this_ptr);
    callback.ensure_still_alive();
    let bound = callback.bind(global, js_wrapper, &bun_core::String::EMPTY, 0.0, &[])?;
    set_slot(js_wrapper, global, bound);
    shadow.set(callback);
    Ok(bound)
}

impl UpgradedDuplex {
    // SAFETY (all handlers): the SSLWrapper handlers ctx is `self as *mut
    // Self`, live for the wrapper's lifetime.

    #[inline]
    fn wrapper_ref(&self) -> Option<&WrapperType> {
        self.wrapper.get().as_ref()
    }

    /// Holds a ref on the owning context until the returned guard drops.
    ///
    /// The context must not be freed while a frame of this engine is on the
    /// stack. It frees itself from a task that it queues once the connection
    /// has closed and nothing holds it, and a callback only has to turn the
    /// event loop synchronously for queued tasks to run under that frame
    /// (`expect().resolves` does, and so does `Bun.build` with an async
    /// plugin `setup()`). The close can come from the program, the peer or
    /// the engine. An entry point that dispatches to a handler, to the TLS
    /// engine or to the wrapped stream holds this guard, so the free waits
    /// until the entry point is done.
    pub(super) fn keep_alive(&self) -> bun_ptr::RefPtr<DuplexUpgradeContext> {
        // SAFETY: `handlers.ctx` is the live context that holds `self` as `.upgrade`.
        DuplexUpgradeContext::keep_alive(unsafe { bun_ptr::ThisPtr::new(self.handlers.ctx.cast()) })
    }

    /// A call on the wrapped stream runs JS, like a dispatch to a handler.
    #[inline]
    fn debug_assert_kept_alive(&self) {
        // SAFETY: as in `keep_alive`.
        unsafe { &*self.handlers.ctx.cast::<DuplexUpgradeContext>() }.debug_assert_kept_alive();
    }

    fn on_open(this: *mut Self) {
        bun_output::scoped_log!(UpgradedDuplex, "onOpen");
        // SAFETY: see handler note above.
        let this = unsafe { &*this };
        (this.handlers.on_open)(this.handlers.ctx);
    }

    fn on_data(this: *mut Self, decoded_data: &[u8]) {
        bun_output::scoped_log!(UpgradedDuplex, "onData ({})", decoded_data.len());
        // SAFETY: see handler note above.
        let this = unsafe { &*this };
        (this.handlers.on_data)(this.handlers.ctx, decoded_data);
    }

    fn on_session(this: *mut Self, session: &[u8]) {
        bun_output::scoped_log!(UpgradedDuplex, "onSession ({})", session.len());
        // SAFETY: see handler note above.
        let this = unsafe { &*this };
        (this.handlers.on_session)(this.handlers.ctx, session);
    }

    fn on_keylog(this: *mut Self, line: &[u8]) {
        bun_output::scoped_log!(UpgradedDuplex, "onKeylog ({})", line.len());
        // SAFETY: see handler note above.
        let this = unsafe { &*this };
        (this.handlers.on_keylog)(this.handlers.ctx, line);
    }

    fn server_identity(
        this: *mut Self,
        ssl: &mut bun_boringssl_sys::SSL,
    ) -> bun_boringssl::ServerIdentity {
        // SAFETY: see handler note above.
        let this = unsafe { &*this };
        (this.handlers.server_identity)(this.handlers.ctx, ssl)
    }

    fn on_handshake(this: *mut Self, handshake_success: bool, ssl_error: us_bun_verify_error_t) {
        bun_output::scoped_log!(UpgradedDuplex, "onHandshake");
        // SAFETY: see handler note above.
        let this = unsafe { &*this };
        this.ssl_error.set(CertError {
            error_no: ssl_error.error_no,
            code: ssl_error
                .code()
                .filter(|_| ssl_error.error_no != 0)
                .map(Into::into),
            reason: ssl_error
                .reason()
                .filter(|_| ssl_error.error_no != 0)
                .map(Into::into),
        });
        (this.handlers.on_handshake)(this.handlers.ctx, handshake_success, ssl_error);
        // Retry writes parked during the handshake, like openssl.c's `ssl_write_wants_read`.
        if handshake_success && !this.is_shutdown() {
            (this.handlers.on_writable)(this.handlers.ctx);
        }
    }

    fn on_close(this: *mut Self) {
        bun_output::scoped_log!(UpgradedDuplex, "onClose");
        // SAFETY: see handler note above.
        unsafe { &*this }.finish_close();
    }

    fn on_end(this: *mut Self) {
        // SAFETY: see handler note above.
        let this = unsafe { &*this };
        (this.handlers.on_end)(this.handlers.ctx);
    }

    pub(super) fn finish_close(&self) {
        let _keep_alive = self.keep_alive();
        // StartTLS still owns the connection until it consumes this close, even after native detach.
        if self.wrapper_ref().is_none() && _keep_alive.has_queued_start() {
            self.pending_close.set(true);
            return;
        }
        // Keep the wrapper (and so its visited `duplex*` slots) reachable
        // across `handlers.on_close`, which downgrades the socket's own strong
        // self-reference and re-enters JS.
        let js_wrapper = self.js_wrapper;
        js_wrapper.ensure_still_alive();

        (self.handlers.on_close)(self.handlers.ctx);
        // Left paused, a net.Socket transport never reads its peer's FIN and stays open.
        if self.paused_origin.get() {
            self.resume_stream();
        }

        // Early teardown (struct itself is dropped later by parent).
        self.teardown();
        js_wrapper.ensure_still_alive();
    }

    /// https://github.com/nodejs/node/blob/v26.3.0/lib/internal/js_stream_socket.js#L117-L125
    #[uws_callback(export = "UpgradedDuplex__pause_stream")]
    pub(crate) fn pause_stream(&self) -> bool {
        let context = self.keep_alive();
        // Like a connecting fd: on_open forgets the owner's pause, so nothing would resume this one.
        if self.wrapper_ref().is_none() {
            return false;
        }
        if context.uses_native_transport() {
            // Intent survives displacement; publish it before the lower stream can re-enter.
            self.paused_origin.set(true);
            return context.reconcile_native_reads();
        }
        let paused = self.call_origin("pause");
        self.paused_origin.set(self.paused_origin.get() || paused);
        paused
    }

    #[uws_callback(export = "UpgradedDuplex__resume_stream")]
    pub(crate) fn resume_stream(&self) -> bool {
        let context = self.keep_alive();
        self.paused_origin.set(false);
        if context.uses_native_transport() {
            context.reconcile_native_reads()
        } else {
            self.call_origin("resume")
        }
    }

    pub(super) fn native_read_paused(&self) -> bool {
        self.paused_origin.get()
    }

    pub(super) fn take_native_pause(&self) -> bool {
        self.paused_origin.replace(false)
    }

    /// `origin[name]()`. A throw goes to `on_error`. False when the call did not complete.
    fn call_origin(&self, name: &str) -> bool {
        self.debug_assert_kept_alive();
        let duplex = self.origin.get();
        if duplex.is_empty() {
            return false;
        }
        let Some(global) = self.global else {
            return false;
        };
        let result = match duplex.get(&global, name) {
            Ok(Some(method)) if method.is_callable() => method.call(&global, duplex, &[]),
            Ok(_) => return false,
            Err(err) => Err(err),
        };
        match result {
            Ok(_) => true,
            Err(err) => {
                (self.handlers.on_error)(self.handlers.ctx, global.take_error(err));
                false
            }
        }
    }

    fn call_write_or_end(&self, data: Option<&[u8]>, msg_more: bool) {
        self.debug_assert_kept_alive();
        // No JS duplex to talk to: the zeroed placeholder, or the owning
        // socket's finalizer abandoned it (`abandon_js_side`).
        let duplex = self.origin.get();
        if duplex.is_empty() {
            return;
        }
        // global is set in `from()` whenever origin is set.
        let Some(global) = self.global else { return };

        // Drop close_notify aimed at an already-ended transport, but still register end's
        // completion callback: native owners join that callback before reporting shutdown.
        let teardown = data.is_some() && self.is_shutdown();
        if teardown {
            // A readable EOF still permits close_notify while the transport is writable.
            // Node ends no destroyed stream.
            // Socket queues must drain without another write-after-FIN error. A generic
            // Duplex with a pending end still needs its write error to complete shutdown.
            let ended = if self.is_node_socket {
                "writableEnded"
            } else {
                "writableFinished"
            };
            for property in [ended, "destroyed"] {
                match duplex.get(&global, property) {
                    Ok(Some(done)) if done.to_boolean() => return,
                    Ok(_) => {}
                    // Best-effort probe: consume the exception and fall through.
                    Err(err) => drop(global.take_exception(err)),
                }
            }
        }

        let name = if msg_more { "write" } else { "end" };
        let write_or_end = match duplex.get(&global, name) {
            Ok(Some(f)) if f.is_callable() => f,
            Ok(_) => return,
            Err(err) => {
                (self.handlers.on_error)(self.handlers.ctx, global.take_error(err));
                return;
            }
        };

        let callback = match lazy_js_handler(
            &self.on_write_callback,
            self.js_wrapper,
            js_TLSSocket::duplex_on_write_get_cached,
            js_TLSSocket::duplex_on_write_set_cached,
            &global,
            listeners::Bun__UpgradedDuplex__onWriteComplete,
            std::ptr::from_ref(self).cast_mut().cast(),
        ) {
            Ok(callback) => callback,
            Err(err) => {
                self.write_failed.set(true);
                (self.handlers.on_error)(self.handlers.ctx, global.take_error(err));
                return;
            }
        };
        let chunk = if let Some(data) = data {
            let buffer = match bun_jsc::array_buffer::BinaryType::Buffer.to_js(data, &global) {
                Ok(b) => b,
                Err(err) => {
                    self.write_failed.set(true);
                    (self.handlers.on_error)(self.handlers.ctx, global.take_error(err));
                    return;
                }
            };
            self.pending_writes.set(self.pending_writes.get() + 1);
            buffer
        } else {
            // shutdown() counted this end before queueing it, so a join cannot observe a gap.
            JSValue::NULL
        };
        self.transport_call_depth
            .set(self.transport_call_depth.get() + 1);
        let result = write_or_end.call(&global, duplex, &[chunk, callback]);
        self.transport_call_depth
            .set(self.transport_call_depth.get() - 1);
        chunk.ensure_still_alive();
        if let Err(err) = result {
            // A synchronous callback may already be queued. Its deferred dispatch owns the count.
            self.write_failed.set(true);
            (self.handlers.on_error)(self.handlers.ctx, global.take_error(err));
        }
    }

    pub(super) fn transport_idle(&self) -> bool {
        let context = self.keep_alive();
        if context.uses_native_transport() {
            context.native_idle()
        } else {
            self.pending_writes.get() == 0 && !self.write_failed.get()
        }
    }

    fn queue_write_completion(&self, global: &JSGlobalObject, status: i32) -> JsResult<()> {
        let callback = lazy_js_handler(
            &self.on_write_dispatch,
            self.js_wrapper,
            js_TLSSocket::duplex_write_dispatch_get_cached,
            js_TLSSocket::duplex_write_dispatch_set_cached,
            global,
            listeners::Bun__UpgradedDuplex__dispatchWriteComplete,
            std::ptr::from_ref(self).cast_mut().cast(),
        )?;
        // Keep the ciphertext pending through the check phase, even for a synchronous origin callback.
        let context = global.bun_vm().context_of(self.context);
        crate::timer::All::set_immediate(
            &global.js_thread(context),
            callback,
            JSValue::from(status),
        )?;
        Ok(())
    }

    fn queue_close(&self, global: &JSGlobalObject) -> JsResult<()> {
        let callback = lazy_js_handler(
            &self.on_close_dispatch,
            self.js_wrapper,
            js_TLSSocket::duplex_close_dispatch_get_cached,
            js_TLSSocket::duplex_close_dispatch_set_cached,
            global,
            listeners::Bun__UpgradedDuplex__dispatchClose,
            std::ptr::from_ref(self).cast_mut().cast(),
        )?;
        let context = global.bun_vm().context_of(self.context);
        crate::timer::All::set_immediate(&global.js_thread(context), callback, JSValue::UNDEFINED)?;
        Ok(())
    }

    fn internal_write(this: *mut Self, encoded_data: &[u8]) {
        // SAFETY: see handler note above.
        unsafe { &*this }.write_encrypted(encoded_data);
    }

    fn write_encrypted(&self, encoded_data: &[u8]) {
        self.reset_timeout();
        let context = self.keep_alive();
        if context.uses_native_transport() {
            context.write_native(encoded_data);
            return;
        }

        // Possible scenarios:
        // Scenario 1: will not write if vm is shutting down (we cannot do anything about it)
        // Scenario 2: will not write if a exception is thrown (will be handled by onError)
        // Scenario 3: will be queued in memory and will be flushed later
        // Scenario 4: no write/end function exists (will be handled by onError)
        self.call_write_or_end(Some(encoded_data), true);
    }

    #[uws_callback(export = "UpgradedDuplex__flush")]
    pub(crate) fn flush(&self) {
        let _keep_alive = self.keep_alive();
        if let Some(w) = self.wrapper_ref() {
            let _ = w.flush();
        }
    }

    pub(super) fn receive_native_data(&self, data: &[u8]) {
        self.on_internal_receive_data(data);
    }

    pub(super) fn receive_native_end(&self) {
        let _context = self.keep_alive();
        (self.handlers.on_end)(self.handlers.ctx);
    }

    fn on_internal_receive_data(&self, data: &[u8]) {
        let _context = self.keep_alive();
        if let Some(w) = self.wrapper_ref() {
            self.reset_timeout();
            w.receive_data(data);
            return;
        }
        // Engine not up yet - `start_tls` is still queued. Stage the bytes;
        // `drain_pending` feeds them in as soon as the engine is up.
        self.pending_data.with_mut(|p| p.extend_from_slice(data));
    }

    /// Replay bytes that arrived before the engine existed. Called by
    /// `DuplexUpgradeContext::run_event` once the `StartTLS` branch has
    /// finished its bookkeeping, so the replay is indistinguishable from an
    /// ordinary post-start delivery.
    pub(super) fn drain_pending(&self) {
        let _keep_alive = self.keep_alive();
        // Nothing to replay, or the engine never came up (the socket died
        // before `StartTLS`). Bail before taking so the bytes are not
        // destroyed by a drain that could not deliver them.
        if self.wrapper_ref().is_none() {
            return;
        }
        if self.pending_data.get().is_empty() {
            self.drain_pending_shutdown();
            return;
        }
        // Taking ownership is load-bearing: a re-entrant `teardown()` clears `pending_data`.
        let staged = self.pending_data.replace(Vec::new());
        self.reset_timeout();
        if let Some(w) = self.wrapper_ref() {
            w.receive_data(&staged);
        }
        self.drain_pending_shutdown();
    }

    /// After the staged input: a server answers a staged ClientHello before the end().
    fn drain_pending_shutdown(&self) {
        if self.pending_shutdown.replace(false) {
            self.shutdown();
        }
    }

    pub(crate) fn on_timeout(&self) {
        bun_output::scoped_log!(UpgradedDuplex, "onTimeout");

        let has_been_cleared = self.event_loop_timer.get().state == EventLoopTimerState::CANCELLED
            || self.vm.is_none_or(|vm| {
                vm.script_execution_status() != bun_jsc::ScriptExecutionStatus::Running
            });

        self.event_loop_timer.with_mut(|t| {
            t.state = EventLoopTimerState::FIRED;
            t.heap = Default::default();
        });

        if has_been_cleared {
            return;
        }

        let _keep_alive = self.keep_alive();
        (self.handlers.on_timeout)(self.handlers.ctx);
    }

    pub(crate) fn from(
        global: &JSGlobalObject,
        js_wrapper: JSValue,
        origin: JSValue,
        is_node_socket: bool,
        context: bun_jsc::ContextId,
        handlers: Handlers,
    ) -> UpgradedDuplex {
        js_TLSSocket::duplex_origin_set_cached(js_wrapper, global, origin);
        UpgradedDuplex {
            vm: Some(global.bun_vm()),
            js_wrapper,
            origin: Cell::new(origin),
            global: Some(GlobalRef::from(global)),
            wrapper: JsCell::new(None),
            handlers,
            ssl_error: JsCell::new(CertError::default()),
            on_data_callback: Cell::new(JSValue::ZERO),
            on_end_callback: Cell::new(JSValue::ZERO),
            on_writable_callback: Cell::new(JSValue::ZERO),
            on_close_callback: Cell::new(JSValue::ZERO),
            on_write_callback: Cell::new(JSValue::ZERO),
            on_write_dispatch: Cell::new(JSValue::ZERO),
            on_close_dispatch: Cell::new(JSValue::ZERO),
            pending_writes: Cell::new(0),
            shutdown_queued: Cell::new(false),
            write_failed: Cell::new(false),
            transport_call_depth: Cell::new(0),
            context,
            event_loop_timer: JsCell::new(EventLoopTimer::init_paused(
                EventLoopTimerTag::UpgradedDuplex,
            )),
            current_timeout: Cell::new(0),
            pending_data: JsCell::new(Vec::new()),
            pending_close: Cell::new(false),
            pending_shutdown: Cell::new(false),
            paused_origin: Cell::new(false),
            is_node_socket,
        }
    }

    pub(crate) fn get_js_handlers(&self, global: &JSGlobalObject) -> JsResult<JSValue> {
        let array = JSValue::create_empty_array(global, 4)?;
        array.ensure_still_alive();

        let this_ptr = std::ptr::from_ref(self).cast_mut().cast::<c_void>();
        let js_wrapper = self.js_wrapper;
        array.put_index(
            global,
            0,
            lazy_js_handler(
                &self.on_data_callback,
                js_wrapper,
                js_TLSSocket::duplex_on_data_get_cached,
                js_TLSSocket::duplex_on_data_set_cached,
                global,
                listeners::Bun__UpgradedDuplex__onReceivedData,
                this_ptr,
            )?,
        )?;
        array.put_index(
            global,
            1,
            lazy_js_handler(
                &self.on_end_callback,
                js_wrapper,
                js_TLSSocket::duplex_on_end_get_cached,
                js_TLSSocket::duplex_on_end_set_cached,
                global,
                listeners::Bun__UpgradedDuplex__onEnd,
                this_ptr,
            )?,
        )?;
        array.put_index(
            global,
            2,
            lazy_js_handler(
                &self.on_writable_callback,
                js_wrapper,
                js_TLSSocket::duplex_on_writable_get_cached,
                js_TLSSocket::duplex_on_writable_set_cached,
                global,
                listeners::Bun__UpgradedDuplex__onWritable,
                this_ptr,
            )?,
        )?;
        array.put_index(
            global,
            3,
            lazy_js_handler(
                &self.on_close_callback,
                js_wrapper,
                js_TLSSocket::duplex_on_close_get_cached,
                js_TLSSocket::duplex_on_close_set_cached,
                global,
                listeners::Bun__UpgradedDuplex__onCloseJS,
                this_ptr,
            )?,
        )?;

        Ok(array)
    }

    fn wrapper_handlers(&self) -> super::ssl_wrapper::Handlers<*mut UpgradedDuplex> {
        super::ssl_wrapper::Handlers {
            ctx: std::ptr::from_ref(self).cast_mut(),
            on_open: Self::on_open,
            on_handshake: Self::on_handshake,
            on_data: Self::on_data,
            on_close: Self::on_close,
            on_end: Some(Self::on_end),
            write: Self::internal_write,
            on_session: Some(Self::on_session),
            on_keylog: Some(Self::on_keylog),
            server_identity: Some(Self::server_identity),
        }
    }

    fn install_and_start(&self, wrapper: WrapperType, verify: ServerVerify) {
        let _context = self.keep_alive();
        self.wrapper.set(Some(wrapper));
        let w = self.wrapper_ref().unwrap();
        w.set_server_verify(verify.request_cert, verify.reject_unauthorized);
        w.start();
    }

    pub(crate) fn start_tls(
        &self,
        ssl_options: &crate::server::server_config::SSLConfig,
        is_client: bool,
        verify: ServerVerify,
    ) -> Result<(), crate::Error> {
        let wrapper = super::ssl_wrapper::init(ssl_options, is_client, self.wrapper_handlers())?;
        self.install_and_start(wrapper, verify);
        Ok(())
    }

    /// Mirrors `start_tls` but skips the
    /// `SSLConfig.asUSockets() → us_ssl_ctx_from_options()` round-trip so a
    /// memoised `SecureContext` can be reused on the duplex/named-pipe path.
    pub(crate) fn start_tls_with_ctx(
        &self,
        ctx: bun_boringssl_sys::OwnedSslCtx,
        is_client: bool,
        verify: ServerVerify,
    ) -> Result<(), crate::Error> {
        let wrapper = WrapperType::init_with_ctx(ctx, is_client, self.wrapper_handlers())?;
        self.install_and_start(wrapper, verify);
        Ok(())
    }

    #[uws_callback(export = "UpgradedDuplex__encode_and_write")]
    pub(crate) fn encode_and_write(&self, data: &[u8]) -> i32 {
        bun_output::scoped_log!(UpgradedDuplex, "encodeAndWrite (len: {})", data.len());
        let _keep_alive = self.keep_alive();
        if let Some(w) = self.wrapper_ref() {
            let written = w.write_data(data).unwrap_or(0);
            return i32::try_from(written).expect("int cast");
        }
        0
    }

    #[uws_callback(export = "UpgradedDuplex__raw_write")]
    pub(crate) fn raw_write(&self, encoded_data: &[u8]) -> i32 {
        let _keep_alive = self.keep_alive();
        self.write_encrypted(encoded_data);
        i32::try_from(encoded_data.len()).expect("int cast")
    }

    /// The owning socket wrapper is being finalized: the JS duplex may be dead
    /// too and a finalizer dispatches nothing, so the SSL shutdown that
    /// follows writes no close_notify and ends nothing — it only unwinds the
    /// native side.
    #[uws_callback(export = "UpgradedDuplex__abandon_js_side", no_catch)]
    pub(crate) fn abandon_js_side(&self) {
        let context = self.keep_alive();
        context.unlink_native(true);
        self.origin.set(JSValue::ZERO);
        // Finalization may follow collection of the targets. Do not inspect their JS cells.
        for callback in [
            &self.on_data_callback,
            &self.on_end_callback,
            &self.on_writable_callback,
            &self.on_close_callback,
            &self.on_write_callback,
            &self.on_write_dispatch,
            &self.on_close_dispatch,
        ] {
            callback.set(JSValue::ZERO);
        }
    }

    #[uws_callback(export = "UpgradedDuplex__close")]
    pub(crate) fn close(&self) {
        let _keep_alive = self.keep_alive();
        let Some(w) = self.wrapper_ref() else {
            if _keep_alive.uses_native_transport() {
                // Native termination can suppress StartTLS; explicit upper close still owns teardown.
                self.finish_close();
            } else {
                self.pending_close.set(true);
            }
            return;
        };
        let _ = w.shutdown(true);
    }

    /// Half-close like `us_internal_ssl_shutdown`: close_notify (none mid-handshake), then end().
    #[uws_callback(export = "UpgradedDuplex__shutdown")]
    pub(crate) fn shutdown(&self) {
        let _keep_alive = self.keep_alive();
        let Some(w) = self.wrapper_ref() else {
            self.pending_shutdown.set(true);
            return;
        };
        let _ = w.shutdown(false);
        if _keep_alive.uses_native_transport() {
            _keep_alive.shutdown_native();
            return;
        }
        if self.origin.get().is_empty() || self.shutdown_queued.replace(true) {
            return;
        }
        let Some(global) = self.global else { return };
        self.pending_writes.set(self.pending_writes.get() + 1);
        let callback = bun_jsc::JSFunction::create(
            &global,
            "",
            listeners::Bun__UpgradedDuplex__endTransport,
            1,
            Default::default(),
        );
        if let Err(err) = JSValue::call_next_tick_1(callback, &global, self.js_wrapper) {
            self.write_failed.set(true);
            (self.handlers.on_error)(self.handlers.ctx, global.take_error(err));
        }
    }

    #[uws_callback(export = "UpgradedDuplex__shutdown_read")]
    pub(crate) fn shutdown_read(&self) {
        let _context = self.keep_alive();
        if let Some(w) = self.wrapper_ref() {
            w.shutdown_read();
        }
    }

    /// `None` means `start_tls` has not run yet (teardown never clears the slot), not shut down.
    #[uws_callback(export = "UpgradedDuplex__is_shutdown", no_catch)]
    pub(crate) fn is_shutdown(&self) -> bool {
        self.wrapper_ref().is_some_and(|w| w.is_write_shutdown())
    }

    /// See [`Self::is_shutdown`] for the not-yet-started case.
    #[uws_callback(export = "UpgradedDuplex__is_closed", no_catch)]
    pub(crate) fn is_closed(&self) -> bool {
        self.wrapper_ref().is_some_and(|w| w.is_closed())
    }

    #[uws_callback(export = "UpgradedDuplex__is_established", no_catch)]
    pub(crate) fn is_established(&self) -> bool {
        !self.is_closed()
    }

    fn ssl(&self) -> Option<*mut bun_boringssl_sys::SSL> {
        self.wrapper_ref()
            .and_then(|w| w.ssl.get())
            .map(|p| p.as_ptr())
    }

    #[uws_callback(export = "UpgradedDuplex__ssl_error", no_catch)]
    pub(crate) fn ssl_error(&self) -> us_bun_verify_error_t {
        let err = self.ssl_error.get();
        us_bun_verify_error_t {
            error_no: err.error_no,
            code: err.code.as_deref().map_or(c"".as_ptr(), |c| c.as_ptr()),
            reason: err.reason.as_deref().map_or(c"".as_ptr(), |c| c.as_ptr()),
            // `struct us_bun_verify_error_t` (libusockets.h) has exactly these
            // three fields: { int error; const char* code; const char* reason }.
        }
    }

    fn reset_timeout(&self) {
        self.set_timeout_in_milliseconds(self.current_timeout.get());
    }

    fn set_timeout_in_milliseconds(&self, ms: c_uint) {
        if self.event_loop_timer.get().state == EventLoopTimerState::ACTIVE {
            timer_all().remove(self.event_loop_timer.as_ptr());
        }
        self.current_timeout.set(ms);

        // if the interval is 0 means that we stop the timer
        if ms == 0 {
            return;
        }

        // reschedule the timer
        // Note: `EventLoopTimer.next` is the lower-tier `ElTimespec` stub;
        // bridge from `bun_core::Timespec` until the lower tier switches.
        let next =
            bun_core::Timespec::ms_from_now(bun_core::TimespecMockMode::ForceRealTime, ms as i64);
        self.event_loop_timer.with_mut(|t| {
            t.next = ElTimespec {
                sec: next.sec,
                nsec: next.nsec,
            };
        });
        timer_all().insert(
            core::ptr::addr_of!(self.event_loop_timer)
                .cast::<bun_event_loop::EventLoopTimer::EventLoopTimer>()
                .cast_mut(),
        );
    }

    #[uws_callback(export = "UpgradedDuplex__set_timeout")]
    pub(crate) fn set_timeout(&self, seconds: c_uint) {
        bun_output::scoped_log!(UpgradedDuplex, "setTimeout({})", seconds);
        self.set_timeout_in_milliseconds(seconds * 1000);
    }

    /// Side-effecting teardown shared by `on_close` (early) and `Drop` (final).
    /// Idempotent: resets to empty state. Also invoked by
    /// `DuplexUpgradeContext`'s connect-error branches so the listener thunks
    /// are neutered while the wrapper is still strongly reachable.
    pub(super) fn teardown(&self) {
        bun_output::scoped_log!(UpgradedDuplex, "deinit");
        if !self.handlers.ctx.is_null() {
            let context = unsafe { &*self.handlers.ctx.cast::<super::DuplexUpgradeContext>() };
            context.teardown_native(self.origin.get().is_empty());
        }
        // clear the timer
        self.set_timeout(0);

        // Neuter in place rather than `self.wrapper.set(None)`: `teardown()`
        // can run re-entrantly from `on_close` while a
        // `SSLWrapper::handle_traffic` frame is still on the stack with a
        // `&SSLWrapper` into the `Some` payload. Assigning `None` runs `Drop`
        // (fine - `deinit()` nulls `ssl`/`ctx`) but then memmoves a fresh
        // `Option::None` value over the slot, whose payload bytes are stack
        // garbage - the in-flight frame's `self.ssl` then reads junk and
        // `flush_pending_events` UAFs into BoringSSL. `deinit()` alone leaves
        // `ssl == None` / `closed_notified` readable so those guards work; the
        // `Option` is dropped for real when the parent `DuplexUpgradeContext`
        // is freed, by the hop it queues once no entry point holds it. See
        // WindowsNamedPipe's WRAPPER_BUSY for the sibling pattern.
        if let Some(w) = self.wrapper_ref() {
            w.deinit();
        }

        // Neuter the listener thunks so a late `origin` event sees null
        // function data instead of a freed `*mut Self`. GC-root clearing is
        // left to the wrapper's own collection.
        self.origin.set(JSValue::ZERO);
        for cb in [
            &self.on_data_callback,
            &self.on_end_callback,
            &self.on_writable_callback,
            &self.on_close_callback,
            &self.on_write_callback,
            &self.on_write_dispatch,
            &self.on_close_dispatch,
        ] {
            let value = cb.get();
            if !value.is_empty() {
                host_fn::set_function_data(value, None);
                cb.set(JSValue::ZERO);
            }
        }
        self.ssl_error.set(CertError::default());
        self.pending_data.set(Vec::new());
        self.pending_close.set(false);
        self.pending_shutdown.set(false);
        self.pending_writes.set(0);
        self.shutdown_queued.set(false);
        self.write_failed.set(false);
    }
}

impl Drop for UpgradedDuplex {
    fn drop(&mut self) {
        self.teardown();
    }
}

// Node's JSStreamSocket.doShutdown ends the transport on the next tick, after its TLS writes.
// https://github.com/nodejs/node/blob/v24.21.0/lib/internal/js_stream_socket.js#L156-L161
pub(crate) fn end_transport(_cx: &mut JsScope<'_>, owner: JsLocal<'_>) {
    let owner = owner.to_js();
    if let Some(socket) = js_TLSSocket::from_js(owner) {
        // SAFETY: the queued argument roots the JS owner; close detaches its native handle.
        let socket = unsafe { &*socket.as_ptr() };
        if let bun_uws::InternalSocket::UpgradedDuplex(duplex) = socket.socket.get().socket {
            // SAFETY: this live handle was installed by DuplexUpgradeContext::duplex_socket.
            let duplex = unsafe { &*duplex.cast::<UpgradedDuplex>() };
            let _keep_alive = duplex.keep_alive();
            duplex.call_write_or_end(None, false);
        }
    }
}

// SAFETY (all four listeners): the function data is the `*mut UpgradedDuplex`
// installed by `get_js_handlers`; `teardown` clears it before the storage is
// freed, so a non-null data pointer is live for the call.

pub(crate) fn on_received_data<'a>(
    cx: &mut JsScope<'a>,
    callee: JsLocal<'a>,
    data: DuplexChunk<'a>,
) {
    bun_output::scoped_log!(UpgradedDuplex, "onReceivedData");

    if let Some(self_ptr) = host_fn::get_function_data(callee.to_js()) {
        // SAFETY: see the note above.
        let this = unsafe { &*self_ptr.cast::<UpgradedDuplex>() };
        let _keep_alive = this.keep_alive();
        if !this.origin.get().is_empty() {
            match data {
                DuplexChunk::None => {}
                // The bytes are copied before a handler of the socket runs.
                DuplexChunk::Bytes(buffer) => buffer.with_bytes(&cx.heap, |payload| {
                    this.on_internal_receive_data(payload);
                }),
                DuplexChunk::Other(_) => {
                    // node.js errors in this case with the same error, lets keep it consistent
                    let error_value = cx
                        .global()
                        .err(
                            bun_jsc::ErrorCode::STREAM_WRAP,
                            format_args!("Stream has StringDecoder set or is in objectMode"),
                        )
                        .to_js();
                    error_value.ensure_still_alive();
                    (this.handlers.on_error)(this.handlers.ctx, error_value);
                }
            }
        }
    }
}

pub(crate) fn on_end(_: &mut JsScope<'_>, callee: JsLocal<'_>) {
    bun_output::scoped_log!(UpgradedDuplex, "onEnd");

    if let Some(self_ptr) = host_fn::get_function_data(callee.to_js()) {
        // SAFETY: see the note above.
        let this = unsafe { &*self_ptr.cast::<UpgradedDuplex>() };
        let _keep_alive = this.keep_alive();

        // Like node's JSStreamSocket. Ahead of staged bytes too: no handshake can complete after it.
        (this.handlers.on_end)(this.handlers.ctx);
    }
}

pub(crate) fn on_writable(_: &mut JsScope<'_>, callee: JsLocal<'_>) {
    bun_output::scoped_log!(UpgradedDuplex, "onWritable");

    if let Some(self_ptr) = host_fn::get_function_data(callee.to_js()) {
        // SAFETY: see the note above.
        let this = unsafe { &*self_ptr.cast::<UpgradedDuplex>() };
        let _context = this.keep_alive();
        // An origin may emit drain inside write/end; the current TLS flush still owns its input.
        if this.transport_call_depth.get() == 0 && !this.write_failed.get() {
            this.flush();
            (this.handlers.on_writable)(this.handlers.ctx);
        }
    }
}

pub(crate) fn on_write_complete<'a>(
    cx: &mut JsScope<'a>,
    callee: JsLocal<'a>,
    error: JsLocal<'a>,
) -> JsResult<()> {
    let global = cx.global();
    if let Some(pointer) = host_fn::get_function_data(callee.to_js()) {
        // The bound callback roots its owner; live teardown neuters this target.
        let this = unsafe { &*pointer.cast::<UpgradedDuplex>() };
        let _context = this.keep_alive();
        let error = error.to_js();
        let queued = (|| -> JsResult<()> {
            // Snapshot before yielding: an origin error listener can mutate err.code.
            let mut status = 0;
            if !error.is_empty() && error.to_boolean() {
                status = -bun_errno::uv_e::PIPE;
                if let Some(code) = error.get(global, "code")? {
                    let code = code.to_bun_string(global)?;
                    if let Some((value, _)) = bun_errno::uv_e::ENTRIES
                        .iter()
                        .find(|(_, name)| code.eq_ascii(name.as_bytes()))
                    {
                        status = *value;
                    }
                }
            }
            // Reading err.code can re-enter destroy and neuter every target.
            if this.origin.get().is_empty() {
                return Ok(());
            }
            this.queue_write_completion(global, status)
        })();
        if let Err(err) = queued {
            // No dispatcher owns this completion. Leave it failed until teardown, never idle.
            this.write_failed.set(true);
            if matches!(err, bun_jsc::JsError::Terminated) {
                return Err(err);
            }
            (this.handlers.on_error)(this.handlers.ctx, global.take_error(err));
        }
    }
    Ok(())
}

pub(crate) fn dispatch_write_complete(cx: &mut JsScope<'_>, callee: JsLocal<'_>, status: i32) {
    let global = cx.global();
    let Some(pointer) = host_fn::get_function_data(callee.to_js()) else {
        return;
    };
    // The queued bound dispatcher roots the owner until the numeric completion is delivered.
    let this = unsafe { &*pointer.cast::<UpgradedDuplex>() };
    let _context = this.keep_alive();
    if this.pending_writes.get() == 0 {
        return;
    }
    this.pending_writes.set(this.pending_writes.get() - 1);
    if status != 0 {
        if !this.write_failed.replace(true) {
            let name = bun_errno::uv_e::name(status).expect("mapped write errno");
            let error = bun_jsc::SystemError {
                errno: status,
                code: bun_core::String::static_(name),
                message: bun_core::String::clone_utf8(format!("write {name}").as_bytes()),
                syscall: bun_core::String::static_("write"),
                ..Default::default()
            }
            .to_error_instance(global);
            (this.handlers.on_error)(this.handlers.ctx, error);
        }
    } else if this.transport_idle() && !this.origin.get().is_empty() {
        (this.handlers.on_writable)(this.handlers.ctx);
    }
}

pub(crate) fn on_close_js(cx: &mut JsScope<'_>, callee: JsLocal<'_>) -> JsResult<()> {
    let global = cx.global();
    bun_output::scoped_log!(UpgradedDuplex, "onCloseJS");

    if let Some(self_ptr) = host_fn::get_function_data(callee.to_js()) {
        // SAFETY: see the note above.
        let this = unsafe { &*self_ptr.cast::<UpgradedDuplex>() };
        let _context = this.keep_alive();
        // Preserve earlier queued write completions before closing this JS-driven transport.
        if let Err(err) = this.queue_close(global) {
            this.write_failed.set(true);
            if matches!(err, bun_jsc::JsError::Terminated) {
                return Err(err);
            }
            (this.handlers.on_error)(this.handlers.ctx, global.take_error(err));
        }
    }
    Ok(())
}

pub(crate) fn dispatch_close(_: &mut JsScope<'_>, callee: JsLocal<'_>) {
    if let Some(pointer) = host_fn::get_function_data(callee.to_js()) {
        // Live teardown neuters the target; the bound dispatcher keeps its owner traced.
        let this = unsafe { &*pointer.cast::<UpgradedDuplex>() };
        let _context = this.keep_alive();
        this.close();
    }
}

// ──────────────────────────────────────────────────────────────────────────
// `bun_uws::UpgradedDuplex` link-time-dispatch shims (cycle break).
//
// `src/uws_sys/lib.rs` declares `UpgradedDuplex` as an opaque handle and binds
// these symbols via `extern "C"` so the low-tier socket dispatch can call into
// the runtime without an upward crate dep. Signatures MUST match the
// `unsafe extern "C"` block there.
//
// All but `ssl` are emitted by `#[uws_callback(export = "...")]` on the
// inherent methods above; `ssl` keeps a hand-written shim because the safe
// method returns `Option<*mut SSL>` while the C ABI flattens to a nullable
// raw pointer.
// ──────────────────────────────────────────────────────────────────────────

#[unsafe(no_mangle)]
extern "C" fn UpgradedDuplex__set_inline_reject(this: *const c_void) {
    // SAFETY: `this` is a live `*const UpgradedDuplex` from the uws_sys opaque handle.
    if let Some(wrapper) = unsafe { (*this.cast::<UpgradedDuplex>()).wrapper_ref() } {
        wrapper.set_inline_reject();
    }
}

#[unsafe(no_mangle)]
extern "C" fn UpgradedDuplex__latest_session(
    this: *const c_void,
) -> *mut bun_boringssl_sys::SSL_SESSION {
    // SAFETY: `this` is a live `*const UpgradedDuplex` from the uws_sys opaque handle.
    unsafe { (*this.cast::<UpgradedDuplex>()).wrapper_ref() }
        .map_or(core::ptr::null_mut(), |wrapper| wrapper.latest_session())
}

#[unsafe(no_mangle)]
extern "C" fn UpgradedDuplex__ssl(this: *const c_void) -> *mut bun_boringssl_sys::SSL {
    // SAFETY: `this` is a live `*const UpgradedDuplex` from the uws_sys opaque handle.
    unsafe {
        (*this.cast::<UpgradedDuplex>())
            .ssl()
            .unwrap_or(core::ptr::null_mut())
    }
}
