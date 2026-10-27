// Minimal Linux N-API bridge. All paths, ownership checks and lifetimes stay
// in JS; these calls neither block nor launch background writing threads.
#define _GNU_SOURCE
#include <node_api.h>
#include <sys/file.h>
#include <fcntl.h>
#include <limits.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
static int argument(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value value; double n;
    if (napi_get_cb_info(env, info, &count, &value, NULL, NULL) != napi_ok || count != 1 ||
        napi_get_value_double(env, value, &n) != napi_ok || !(n >= 3 && n <= INT_MAX) || n != (int)n) {
        napi_throw_type_error(env, NULL, "fence descriptor must be an integer >= 3"); return -1;
    }
    return (int)n;
}
static napi_value try_lock(napi_env env, napi_callback_info info) {
    int fd = argument(env, info); if (fd < 0) return NULL;
    int result = flock(fd, LOCK_EX | LOCK_NB);
    if (result < 0 && errno != EWOULDBLOCK && errno != EAGAIN && errno != EINTR) {
        napi_throw_error(env, NULL, strerror(errno)); return NULL;
    }
    napi_value value; napi_get_boolean(env, result == 0, &value); return value;
}
static napi_value duplicate(napi_env env, napi_callback_info info) {
    int fd = argument(env, info); if (fd < 0) return NULL;
    int copy = fcntl(fd, F_DUPFD_CLOEXEC, 3);
    if (copy < 0) { napi_throw_error(env, NULL, strerror(errno)); return NULL; }
    napi_value value;
    if (napi_create_int32(env, copy, &value) != napi_ok) { close(copy); return NULL; }
    return value;
}
NAPI_MODULE_INIT() {
    napi_property_descriptor methods[] = {
        { .utf8name = "tryLock", .method = try_lock },
        { .utf8name = "duplicate", .method = duplicate },
    };
    napi_define_properties(env, exports, 2, methods); return exports;
}
