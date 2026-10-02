use core::ptr::NonNull;

use bun_io::file_poll::Flags;
use bun_io::{EventLoopCtx, FilePoll, Owner};
use bun_sys::{Fd, FdExt, File, Result};

pub(crate) struct DarwinFileWatch {
    // The poll is deregistered before the owned descriptor is closed.
    fd: Fd,
    poll: NonNull<FilePoll>,
    pub(crate) filename: Box<[u8]>,
}

impl DarwinFileWatch {
    pub(crate) fn new(
        ctx: EventLoopCtx,
        owner: Owner,
        file: File,
        filename: Box<[u8]>,
    ) -> Result<Self> {
        let poll = FilePoll::init(ctx, file.fd(), Default::default(), owner);
        let watch = Self {
            fd: file.into_raw(),
            // SAFETY: FilePoll::init returns a live hive slot or aborts on OOM.
            poll: unsafe { NonNull::new_unchecked(poll) },
            filename,
        };
        watch.arm(ctx)?;
        Ok(watch)
    }

    pub(crate) fn arm(&self, ctx: EventLoopCtx) -> Result<()> {
        // SAFETY: owned live poll; registration cannot enter JS or re-enter this owner.
        unsafe { (*self.poll.as_ptr()).register(ctx.platform_event_loop(), Flags::Vnode, true) }
    }
}

impl Drop for DarwinFileWatch {
    fn drop(&mut self) {
        // SAFETY: the slot belongs to this watch; deinit defers reuse of registered slots.
        unsafe { (*self.poll.as_ptr()).deinit() };
        self.fd.close();
    }
}
