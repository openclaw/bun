use bun_io::file_poll::Flags;
use bun_io::{EventLoopCtx, OwnedFilePoll, Owner};
use bun_sys::{File, Result};

pub(crate) struct DarwinFileWatch {
    // Field drop order deregisters the poll before closing the descriptor.
    poll: OwnedFilePoll<true>,
    _file: File,
    pub(crate) filename: Box<[u8]>,
}

impl DarwinFileWatch {
    pub(crate) fn new(
        ctx: EventLoopCtx,
        owner: Owner,
        file: File,
        filename: Box<[u8]>,
    ) -> Result<Self> {
        // SAFETY: the heap-stable watcher owns this poll until it is dropped.
        let poll = unsafe { OwnedFilePoll::new(ctx, file.fd(), owner) };
        let watch = Self {
            poll,
            _file: file,
            filename,
        };
        watch.arm(ctx)?;
        Ok(watch)
    }

    pub(crate) fn arm(&self, _ctx: EventLoopCtx) -> Result<()> {
        self.poll.register(Flags::Vnode, true)
    }
}
