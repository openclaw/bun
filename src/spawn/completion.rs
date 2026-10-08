//! A process-only readiness snapshot. No socket or file callbacks run here.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

use bun_ptr::RefPtr;
use bun_sys::{Fd, FdExt as _};

use crate::Process;

pub struct CompletionQueue {
    fd: Cell<Option<Fd>>,
    watched: RefCell<HashSet<*mut Process>>,
    retry: RefCell<HashSet<*mut Process>>,
}

impl CompletionQueue {
    pub fn new() -> bun_sys::Result<Rc<Self>> {
        Ok(Rc::new(Self {
            fd: Cell::new(Some(open_descriptor()?)),
            watched: RefCell::new(HashSet::new()),
            retry: RefCell::new(HashSet::new()),
        }))
    }

    /// # Safety
    /// The primary watch retains `process` until it removes this registration.
    /// The queue is held by its event loop, on this thread, until teardown.
    pub unsafe fn add(&self, process: *mut Process) -> bun_sys::Result<()> {
        if self.watched.borrow().contains(&process) {
            return Ok(());
        }
        if self.fd.get().is_none() {
            self.fd.set(Some(open_descriptor()?));
        }
        #[cfg(target_os = "macos")]
        let result = {
            let change = libc::kevent64_s {
                // SAFETY: the caller holds the primary watch ref.
                ident: unsafe { (*process).pid } as u64,
                filter: libc::EVFILT_PROC,
                flags: libc::EV_ADD | libc::EV_ONESHOT,
                fflags: libc::NOTE_EXIT,
                data: 0,
                udata: process as u64,
                ext: [0; 2],
            };
            // SAFETY: live queue, stack-local changelist, no output events.
            retry_interrupted(|| unsafe {
                libc::kevent64(
                    self.fd.get().unwrap().native(),
                    &change,
                    1,
                    std::ptr::null_mut(),
                    0,
                    0,
                    std::ptr::null(),
                )
            })
        };
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let result = {
            // Only this private queue is one-shot: capture retains every
            // returned owner before any callback can re-enter the loop.
            let mut event = libc::epoll_event {
                events: (libc::EPOLLIN | libc::EPOLLONESHOT) as u32,
                u64: process as u64,
            };
            // SAFETY: primary watch holds process/pidfd; event is stack-local.
            retry_interrupted(|| unsafe {
                libc::epoll_ctl(
                    self.fd.get().unwrap().native(),
                    libc::EPOLL_CTL_ADD,
                    (*process).pidfd,
                    &mut event,
                )
            })
        };
        if result < 0 {
            let error = last_error();
            #[cfg(target_os = "macos")]
            if error.get_errno() == bun_sys::E::ESRCH {
                self.retry.borrow_mut().insert(process);
                self.watched.borrow_mut().insert(process);
                // SAFETY: caller contract; Rc keeps this shared backref stable.
                unsafe { (*process).completion_queue = self };
                return Ok(());
            }
            if self.watched.borrow().is_empty() {
                if let Some(fd) = self.fd.take() {
                    close_owned_descriptor(fd);
                }
            }
            return Err(error);
        }
        self.watched.borrow_mut().insert(process);
        // SAFETY: caller contract; removed before process or queue destruction.
        unsafe { (*process).completion_queue = self };
        Ok(())
    }

    /// # Safety
    /// `process` is live and its registration, if any, belongs to this queue.
    pub unsafe fn remove(&self, process: *mut Process) {
        if !self.watched.borrow_mut().remove(&process) {
            return;
        }
        // SAFETY: caller keeps process live during deregistration.
        unsafe { (*process).completion_queue = std::ptr::null() };
        self.retry.borrow_mut().remove(&process);
        #[cfg(target_os = "macos")]
        {
            let change = libc::kevent64_s {
                // SAFETY: caller contract.
                ident: unsafe { (*process).pid } as u64,
                filter: libc::EVFILT_PROC,
                flags: libc::EV_DELETE,
                fflags: 0,
                data: 0,
                udata: 0,
                ext: [0; 2],
            };
            // SAFETY: live queue and stack changelist. EV_ONESHOT may already
            // have deleted the registration; no live pointer remains afterward.
            retry_interrupted(|| unsafe {
                libc::kevent64(
                    self.fd.get().unwrap().native(),
                    &change,
                    1,
                    std::ptr::null_mut(),
                    0,
                    0,
                    std::ptr::null(),
                )
            });
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        // SAFETY: process is live and still owns its pidfd at this point.
        retry_interrupted(|| unsafe {
            libc::epoll_ctl(
                self.fd.get().unwrap().native(),
                libc::EPOLL_CTL_DEL,
                (*process).pidfd,
                std::ptr::null_mut(),
            )
        });
        if self.watched.borrow().is_empty() {
            if let Some(fd) = self.fd.take() {
                close_owned_descriptor(fd);
            }
        }
    }

    pub(crate) fn retry_reap(&self, process: *mut Process) {
        debug_assert!(self.watched.borrow().contains(&process));
        self.retry.borrow_mut().insert(process);
    }

    pub fn capture(&self) -> Vec<RefPtr<Process>> {
        let registered = self.watched.borrow().len();
        if registered == 0 {
            return Vec::new();
        }
        let mut ready = Vec::new();
        for process in self.retry.borrow_mut().drain() {
            // SAFETY: retry contains only registered owners; no callbacks run
            // during capture, and each owner still holds its primary watch ref.
            unsafe {
                (*process).ref_();
                ready.push(RefPtr::from_raw(process));
            }
        }
        #[cfg(target_os = "macos")]
        // SAFETY: kevent64_s is POD, including zeroed unused output slots.
        let mut events: [libc::kevent64_s; 64] = unsafe { std::mem::zeroed() };
        #[cfg(any(target_os = "linux", target_os = "android"))]
        // SAFETY: epoll_event is POD.
        let mut events: [libc::epoll_event; 64] = unsafe { std::mem::zeroed() };
        // One-shot notifications cannot repeat within this capture. Collect the
        // whole ready set, bounded by registrations, without scanning live PIDs.
        while ready.len() < registered {
            let capacity = events.len().min(registered - ready.len()) as i32;
            #[cfg(target_os = "macos")]
            // SAFETY: live queue; output capacity fits events; zero timeout.
            let count = unsafe {
                let timeout = libc::timespec {
                    tv_sec: 0,
                    tv_nsec: 0,
                };
                libc::kevent64(
                    self.fd.get().unwrap().native(),
                    std::ptr::null(),
                    0,
                    events.as_mut_ptr(),
                    capacity,
                    0,
                    &timeout,
                )
            };
            #[cfg(any(target_os = "linux", target_os = "android"))]
            // SAFETY: live queue and output buffer; zero timeout.
            let count = unsafe {
                libc::epoll_wait(
                    self.fd.get().unwrap().native(),
                    events.as_mut_ptr(),
                    capacity,
                    0,
                )
            };
            if count < 0 && bun_sys::get_errno(count) == bun_sys::E::EINTR {
                continue;
            }
            if count <= 0 {
                break;
            }
            for event in &events[..count as usize] {
                #[cfg(target_os = "macos")]
                let process = event.udata as *mut Process;
                #[cfg(any(target_os = "linux", target_os = "android"))]
                let process = event.u64 as *mut Process;
                // SAFETY: registration retains the primary watch ref. Retain
                // this snapshot before permitting tasks to detach an owner.
                unsafe {
                    (*process).ref_();
                    ready.push(RefPtr::from_raw(process));
                }
            }
            if count < capacity {
                break;
            }
        }
        ready
    }
}

impl Drop for CompletionQueue {
    fn drop(&mut self) {
        for &process in self.watched.get_mut().iter() {
            // SAFETY: every registered owner holds its primary watch ref;
            // destruction runs no callbacks and invalidates every backref.
            unsafe { (*process).completion_queue = std::ptr::null() };
        }
        if let Some(fd) = self.fd.take() {
            close_owned_descriptor(fd);
        }
    }
}

fn open_descriptor() -> bun_sys::Result<Fd> {
    #[cfg(target_os = "macos")]
    // SAFETY: kqueue has no pointer arguments.
    let fd = retry_interrupted(|| unsafe { libc::kqueue() });
    #[cfg(any(target_os = "linux", target_os = "android"))]
    // SAFETY: epoll_create1 has no pointer arguments.
    let fd = retry_interrupted(|| unsafe { libc::epoll_create1(libc::EPOLL_CLOEXEC) });
    if fd < 0 {
        return Err(last_error());
    }
    let mut fd = Fd::from_native(fd);
    if fd.stdio_tag().is_some() {
        let moved = loop {
            match bun_sys::dup_at_least(fd, 3) {
                Err(error) if error.get_errno() == bun_sys::E::EINTR => continue,
                result => break result,
            }
        };
        close_owned_descriptor(fd);
        fd = moved?;
    }
    #[cfg(target_os = "macos")]
    if let Err(error) = bun_sys::set_close_on_exec(fd) {
        close_owned_descriptor(fd);
        return Err(error);
    }
    Ok(fd)
}

fn close_owned_descriptor(fd: Fd) {
    // A private queue may occupy 0–2 after the application closes stdio.
    let error = fd.close_allowing_standard_io(None);
    debug_assert!(error.is_none());
}

fn last_error() -> bun_sys::Error {
    #[cfg(target_os = "macos")]
    let tag = bun_sys::Tag::kqueue;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let tag = bun_sys::Tag::epoll_ctl;
    bun_sys::Error::from_code(bun_sys::get_errno(-1i32), tag)
}

fn retry_interrupted(mut operation: impl FnMut() -> i32) -> i32 {
    loop {
        let result = operation();
        if result >= 0 || bun_sys::get_errno(result) != bun_sys::E::EINTR {
            return result;
        }
    }
}
