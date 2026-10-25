#include "root.h"
#include "BunClientData.h"
#include "GCWakeTrace.h"

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <mutex>
#include <new>
#include <thread>
#if OS(WINDOWS)
#include <process.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

#include <JavaScriptCore/VM.h>
#include <JavaScriptCore/Heap.h>

#if OS(WINDOWS)
extern "C" bool Bun__thisThreadHasVM();

struct GCWakeRecord {
    uint64_t committed;
    uint64_t thread;
    uint64_t owner;
    uint64_t object;
    double detail;
    char event[32];
};
static_assert(sizeof(GCWakeRecord) == 72);

struct MappedGCWakeTrace {
    char magic[8];
    uint32_t capacity;
    uint32_t recordSize;
    std::atomic<uint32_t> next;
    std::atomic<uint32_t> completed;
    std::atomic<uint32_t> overflow;
    uint32_t flags;
    GCWakeRecord records[8192];
};
static_assert(offsetof(MappedGCWakeTrace, records) == 32);

static MappedGCWakeTrace* openMappedGCWakeTrace(bool backgroundOnly)
{
    const char* directory = std::getenv("BUN_DIAG_GC_WAKE_DIR");
    if (!directory || !*directory)
        return nullptr;
    char path[4096];
    int length = std::snprintf(path, sizeof(path), "%s/gc-wake-%d.bin", directory, _getpid());
    if (length < 0 || static_cast<size_t>(length) >= sizeof(path))
        return nullptr;
    HANDLE file = CreateFileA(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE)
        return nullptr;
    HANDLE mapping = CreateFileMappingA(file, nullptr, PAGE_READWRITE, 0, static_cast<DWORD>(sizeof(MappedGCWakeTrace)), nullptr);
    CloseHandle(file);
    if (!mapping)
        return nullptr;
    void* memory = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(MappedGCWakeTrace));
    CloseHandle(mapping);
    if (!memory)
        return nullptr;
    // The mapping lives until process exit; dirty records remain readable even if the test kills the process.
    auto* trace = new (memory) MappedGCWakeTrace {};
    std::memcpy(trace->magic, "BUNGCW1", 8);
    trace->capacity = 8192;
    trace->recordSize = sizeof(GCWakeRecord);
    const char* disabled = std::getenv("BUN_GC_TIMER_DISABLE");
    const char* markers = std::getenv("BUN_JSC_numberOfGCMarkers");
    trace->flags = (disabled && disabled[0] == '1' ? 1u : 0u) | (backgroundOnly ? 2u : 0u) | (markers ? static_cast<uint32_t>(std::strtoul(markers, nullptr, 10)) << 8 : 0u);
    return trace;
}

static ALWAYS_INLINE void recordMappedGCWake(MappedGCWakeTrace* trace, const char* event, const void* owner, const void* object, double detail)
{
    uint32_t index = trace->next.fetch_add(1, std::memory_order_relaxed);
    if (index >= trace->capacity) {
        trace->overflow.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    static thread_local DWORD thread = GetCurrentThreadId();
    auto& record = trace->records[index];
    record.thread = thread;
    record.owner = reinterpret_cast<uintptr_t>(owner);
    record.object = reinterpret_cast<uintptr_t>(object);
    record.detail = detail;
    for (size_t i = 0; i < sizeof(record.event) - 1 && event[i]; ++i)
        record.event[i] = event[i];
    std::atomic_ref<uint64_t>(record.committed).store(index + 1, std::memory_order_release);
    trace->completed.fetch_add(1, std::memory_order_release);
}
#endif

extern "C" void Bun__traceGCWake(const char* event, const void* owner, const void* object, double detail)
{
#if OS(WINDOWS)
    static const int mode = [] {
        const char* value = std::getenv("BUN_DIAG_GC_WAKE_MODE");
        if (value && !std::strcmp(value, "memory"))
            return 1;
        if (value && !std::strcmp(value, "background"))
            return 2;
        return 0;
    }();
    if (mode) {
        static MappedGCWakeTrace* trace = openMappedGCWakeTrace(mode == 2);
        if (!trace)
            return;
        if (mode == 2) {
            static thread_local const bool hasVM = Bun__thisThreadHasVM();
            if (hasVM)
                return;
        }
        recordMappedGCWake(trace, event, owner, object, detail);
        return;
    }
#endif
    static FILE* file = []() -> FILE* {
        const char* directory = std::getenv("BUN_DIAG_GC_WAKE_DIR");
        if (!directory || !*directory)
            return nullptr;
        char path[4096];
#if OS(WINDOWS)
        int pid = _getpid();
#else
        int pid = getpid();
#endif
        int length = std::snprintf(path, sizeof(path), "%s/gc-wake-%d.log", directory, pid);
        if (length < 0 || static_cast<size_t>(length) >= sizeof(path))
            return nullptr;
        FILE* output = std::fopen(path, "wb");
        if (output) {
            const char* disableTimer = std::getenv("BUN_GC_TIMER_DISABLE");
            const char* markers = std::getenv("BUN_JSC_numberOfGCMarkers");
            std::fprintf(output, "config gc_timer_disable=%s markers=%s\n", disableTimer ? disableTimer : "unset", markers ? markers : "unset");
        }
        return output;
    }();
    if (!file)
        return;
    static std::mutex mutex;
    static unsigned sequence = 0;
    std::lock_guard<std::mutex> lock(mutex);
    if (sequence >= 100000)
        return;
    auto now = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    auto thread = std::hash<std::thread::id> {}(std::this_thread::get_id());
    std::fprintf(file, "%u %lld %zu %s %p %p %.17g\n", ++sequence, static_cast<long long>(now), thread, event, owner, object, detail);
    std::fflush(file);
}

#if USE(MIMALLOC)
// Matches oven-sh/mimalloc's mi_attr_noexcept declaration; bmalloc's
// vendored mimalloc.h predates this entry point.
extern "C" void mi_on_thread_idle(void) noexcept;
#if OS(WINDOWS)
extern "C" bool mi_on_thread_idle_pending(void) noexcept;
#else
// uSockets' CLOCK_MONOTONIC reading (packages/bun-usockets/src/loop.c). Must be
// the same clock the caller's `nowNs` came from, or the rate limit below
// compares two epochs. Windows always passes a reading, so it needs no fallback.
extern "C" uint64_t us_internal_monotonic_ns(void);
#endif
#endif

// Rust-side `AtomicI32` static (src/jsc/VirtualMachine.rs). Same layout as a plain
// int32_t, but Rust writes it (env parsing) while this thread reads it, so read
// it as an atomic rather than through a plain `int`.
extern "C" std::atomic<int32_t> Bun__defaultRemainingRunsUntilSkipReleaseAccess;

extern "C" void Bun__JSC_acquireHeapAccessAfterWait(JSC::VM* _Nonnull vm)
{
    Bun__traceGCWake("heap_acquire", vm, nullptr, 0);
    vm->heap.acquireAccess();
}

// Returns in how many milliseconds the caller is to call this again even if nothing else
// wakes it (0: no need). Only the libuv loop gets anything but 0.
//
// `releasedHeapAccess` (null where the loop cannot take access back before it dispatches: libuv): set when this gave up
// heap access for the wait, in which case Bun__JSC_acquireHeapAccessAfterWait must run before anything touches the JS
// heap. It does that while an idle collection GarbageCollectionController requested is unfinished
// (JSVMClientData::idleCollectionsPending): a requested collection only advances at this thread's safepoints while this
// thread holds the collector's conn, and a parked thread has none; without access, the conn goes to the collector thread,
// which finishes the collection while this one sleeps.
extern "C" unsigned int Bun__JSC_onBeforeWait(JSC::VM* _Nonnull vm, uint64_t nowNs, int* _Nullable releasedHeapAccess)
{
    ASSERT(vm);
    unsigned int runAgainInMs = 0;
    const bool previouslyHadAccess = vm->heap.hasHeapAccess();
    Bun__traceGCWake("before_wait", vm, nullptr, previouslyHadAccess + 2 * vm->didEnterVM + 4 * WebCore::clientData(*vm)->idleCollectionsPending.load());
    // sanity check for debug builds to ensure we're not doing a
    // use-after-free here
    ASSERT(vm->refCount() > 0);
    if (previouslyHadAccess) {

        // Releasing heap access is a balance between:
        // 1. CPU usage
        // 2. Memory usage
        //
        // Not releasing heap access causes benchmarks like
        // https://github.com/oven-sh/bun/pull/14885 to regress due to
        // finalizers not being called quickly enough.
        //
        // Releasing heap access too often causes high idle CPU usage.
        //
        // For the following code:
        // ```
        // setTimeout(() => {}, 10 * 1000)
        // ```
        //
        // command time -v when with defaultRemainingRunsUntilSkipReleaseAccess = 0:
        //
        //   Involuntary context switches: 605
        //
        // command time -v when with defaultRemainingRunsUntilSkipReleaseAccess = 5:
        //
        //   Involuntary context switches: 350
        //
        // command time -v when with defaultRemainingRunsUntilSkipReleaseAccess = 10:
        //
        //   Involuntary context switches: 241
        //
        // Also comapre the #14885 benchmark with different values.
        //
        // The idea here is if you entered JS "recently", running any
        // finalizers that might've been waiting to be run is a good idea.
        // But if you haven't, like if the process is just waiting on I/O
        // then don't bother.
        const int defaultRemainingRunsUntilSkipReleaseAccess = Bun__defaultRemainingRunsUntilSkipReleaseAccess.load(std::memory_order_relaxed);

        static thread_local int remainingRunsUntilSkipReleaseAccess = 0;

#if USE(MIMALLOC) && OS(WINDOWS)
        // mimalloc wants three more calls after the first at the most; counted from the last time JS ran.
        static constexpr unsigned maxIdleFollowUpSweeps = 3;
        static thread_local unsigned idleFollowUpSweeps = 0;
#endif

        // Note: usage of `didEnterVM` in JSC::VM conflicts with Options::validateDFGClobberize
        // We don't need to use that option, so it should be fine.
        if (vm->didEnterVM) {
            vm->didEnterVM = false;
            remainingRunsUntilSkipReleaseAccess = defaultRemainingRunsUntilSkipReleaseAccess;
#if USE(MIMALLOC) && OS(WINDOWS)
            idleFollowUpSweeps = 0;
#endif
        }

        if (remainingRunsUntilSkipReleaseAccess-- > 0) {
            // Constellation:
            // > If you are not moving a VM to the different thread, then you can aquire the access and do not need to release
            vm->heap.stopIfNecessary();
            vm->didEnterVM = false;

#if USE(MIMALLOC) && OS(WINDOWS)
            // Collect retired pages, punch free-block holes, hand the arena purge to
            // the scavenger. Rate-limited; nowNs is the tick's shared reading (0 = take
            // one), compared by addition so an out-of-order reading cannot underflow.
            //
            // Windows only: everywhere else `us_loop_run_bun_tick` hands the heaps to the
            // scavenger across the poll instead, so this thread never does the sweep itself.
            // The libuv loop has no handoff: uv_run() dispatches completions right after its poll,
            // inside the same call, and libuv allocates from mimalloc. So it keeps paying for it here.
            static constexpr uint64_t idleSweepIntervalNs = 100 * 1000000ULL;
            static thread_local uint64_t lastIdleSweepNs = 0;
            if (nowNs >= lastIdleSweepNs + idleSweepIntervalNs) {
                lastIdleSweepNs = nowNs;
                mi_on_thread_idle();
                // One sweep leaves the free blocks of a large page that was just allocated
                // from, and nothing comes back for them once libuv blocks.
                if (mi_on_thread_idle_pending() && idleFollowUpSweeps < maxIdleFollowUpSweeps) {
                    idleFollowUpSweeps++;
                    runAgainInMs = idleSweepIntervalNs / 1000000;
                }
            }
#endif
        }
    }
    if (releasedHeapAccess && previouslyHadAccess && WebCore::clientData(*vm)->idleCollectionsPending.load()) {
        // If the collector handed the conn back for a stop-the-world phase while this thread was awake, run that phase
        // now rather than at the next time JS happens to run; then park without access so the rest goes on without us.
        vm->heap.stopIfNecessary();
        vm->heap.releaseAccess();
        Bun__traceGCWake("heap_release", vm, nullptr, 0);
        *releasedHeapAccess = 1;
    }
    return runAgainInMs;
}
