#include <node_api.h>
#undef NDEBUG
#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#ifdef _WIN32
#include <io.h>
#include <windows.h>
using Thread = DWORD;
static Thread currentThread() { return GetCurrentThreadId(); }
static bool sameThread(Thread a, Thread b) { return a == b; }
static int openFd() { return _open("NUL", _O_RDONLY); }
static bool fdOpen(int fd) { return _get_osfhandle(fd) != -1; }
static void closeFd(int fd) { _close(fd); }
#else
#include <pthread.h>
#include <unistd.h>
using Thread = pthread_t;
static Thread currentThread() { return pthread_self(); }
static bool sameThread(Thread a, Thread b) { return pthread_equal(a, b); }
static int openFd() { return open("/dev/null", O_RDONLY); }
static bool fdOpen(int fd) { return fcntl(fd, F_GETFD) >= 0; }
static void closeFd(int fd) { close(fd); }
#endif

static constexpr unsigned kinds = 10;
static std::atomic<unsigned> counts[kinds], nullEnv[kinds], offThread,
    reentered, unexpectedStatus;
static std::atomic<int> fds[kinds] = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
struct Item {
  unsigned kind;
  Thread owner;
  void *bytes;
  int fd;
  napi_ref callback = nullptr;
  napi_ref global = nullptr;
  napi_ref finalizerRef = nullptr;
};

static void finalize(napi_env env, void *data, void *hint) {
  auto *item = static_cast<Item *>(hint ? hint : data);
  if (!sameThread(item->owner, currentThread()))
    ++offThread;
  if (!env)
    ++nullEnv[item->kind];
  if (item->callback) {
    napi_value callback, global, result;
    assert(napi_get_reference_value(env, item->callback, &callback) == napi_ok);
    assert(napi_get_reference_value(env, item->global, &global) == napi_ok);
    napi_status status =
        napi_call_function(env, global, callback, 0, nullptr, &result);
    if (status == napi_ok)
      ++reentered;
    else if (status != napi_pending_exception && status != napi_cannot_run_js)
      ++unexpectedStatus;
    assert(napi_delete_reference(env, item->callback) == napi_ok);
    assert(napi_delete_reference(env, item->global) == napi_ok);
  }
  if (item->finalizerRef)
    assert(napi_delete_reference(env, item->finalizerRef) == napi_ok);
  closeFd(item->fd);
  fds[item->kind] = -1;
  ++counts[item->kind];
  if (getenv("NAPI_FINALIZER_TRACE")) {
    printf("finalized %u %s\n", item->kind, env ? "env" : "null");
    fflush(stdout);
  }
  free(item->bytes);
  delete item;
}
static void cleanup(void *data) { finalize(nullptr, data, nullptr); }
static napi_value make(napi_env env, napi_callback_info info) {
  napi_value args[1], array;
  size_t argc = 1;
  assert(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) == napi_ok);
  assert(napi_create_array(env, &array) == napi_ok);
  for (unsigned k = 0; k < kinds; ++k) {
    auto *item = new Item{k, currentThread(), calloc(4096, 1), openFd()};
    assert(item->bytes && item->fd >= 0);
    fds[k] = item->fd;
    napi_value value;
    bool copied = false;
    switch (k) {
    case 0:
      assert(napi_create_reference(env, args[0], 1, &item->callback) ==
             napi_ok);
      assert(napi_get_global(env, &value) == napi_ok);
      assert(napi_create_reference(env, value, 1, &item->global) == napi_ok);
      assert(napi_create_object(env, &value) == napi_ok);
      assert(napi_wrap(env, value, item, finalize, nullptr, nullptr) ==
             napi_ok);
      break;
    case 1:
      assert(napi_create_external_buffer(env, 4096,
                                         static_cast<char *>(item->bytes),
                                         finalize, item, &value) == napi_ok);
      break;
    case 2:
      assert(napi_create_external_arraybuffer(env, item->bytes, 4096, finalize,
                                              item, &value) == napi_ok);
      break;
    case 3:
      memset(item->bytes, 'x', 4096);
      assert(node_api_create_external_string_latin1(
                 env, static_cast<char *>(item->bytes), 4096, finalize, item,
                 &value, &copied) == napi_ok);
      break;
    case 4:
      for (unsigned i = 0; i < 2048; ++i)
        static_cast<char16_t *>(item->bytes)[i] = u'\u03bb';
      assert(node_api_create_external_string_utf16(
                 env, static_cast<char16_t *>(item->bytes), 2048, finalize,
                 item, &value, &copied) == napi_ok);
      break;
    case 5:
      assert(napi_create_external(env, item, finalize, nullptr, &value) ==
             napi_ok);
      break;
    case 6:
      assert(napi_set_instance_data(env, item, finalize, nullptr) == napi_ok);
      assert(napi_get_undefined(env, &value) == napi_ok);
      break;
    case 7:
      assert(napi_add_env_cleanup_hook(env, cleanup, item) == napi_ok);
      assert(napi_get_undefined(env, &value) == napi_ok);
      break;
    case 8:
    case 9:
      assert(napi_create_object(env, &value) == napi_ok);
      assert(napi_add_finalizer(env, value, item, finalize, nullptr,
                                k == 9 ? &item->finalizerRef : nullptr) ==
             napi_ok);
      break;
    }
    assert(napi_set_element(env, array, k, value) == napi_ok);
  }
  return array;
}
static napi_value stats(napi_env env, napi_callback_info) {
  napi_value result, value, array;
  assert(napi_create_object(env, &result) == napi_ok);
  for (unsigned field = 0; field < 2; ++field) {
    assert(napi_create_array(env, &array) == napi_ok);
    for (unsigned k = 0; k < kinds; ++k) {
      assert(napi_create_uint32(env,
                                field ? nullEnv[k].load() : counts[k].load(),
                                &value) == napi_ok);
      assert(napi_set_element(env, array, k, value) == napi_ok);
    }
    assert(napi_set_named_property(env, result, field ? "nullEnv" : "counts",
                                   array) == napi_ok);
  }
  unsigned live = 0;
  for (auto &fd : fds) {
    int n = fd.load();
    if (n >= 0 && fdOpen(n))
      ++live;
  }
  const char *names[] = {"liveFds", "offThread", "reentered",
                         "unexpectedStatus"};
  unsigned values[] = {live, offThread.load(), reentered.load(),
                       unexpectedStatus.load()};
  for (unsigned k = 0; k < 4; ++k) {
    assert(napi_create_uint32(env, values[k], &value) == napi_ok);
    assert(napi_set_named_property(env, result, names[k], value) == napi_ok);
  }
  return result;
}
NAPI_MODULE_INIT() {
  napi_value fn;
  assert(napi_create_function(env, "make", NAPI_AUTO_LENGTH, make, nullptr,
                              &fn) == napi_ok);
  assert(napi_set_named_property(env, exports, "make", fn) == napi_ok);
  assert(napi_create_function(env, "stats", NAPI_AUTO_LENGTH, stats, nullptr,
                              &fn) == napi_ok);
  assert(napi_set_named_property(env, exports, "stats", fn) == napi_ok);
  return exports;
}
