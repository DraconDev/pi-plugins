// Disposable Linux fault control: fail ONLY this prototype's private scratch.
// Never fill a filesystem or intercept unrelated file contents.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/uio.h>

static int fail_stage(int fd, const char *stage) {
    const char *mode = getenv("DRACON_TEST_SCRATCH_IO_FAILURE");
    if (!mode || strcmp(mode, stage)) return 0;
    char proc[64], path[4096];
    snprintf(proc, sizeof(proc), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(proc, path, sizeof(path) - 1);
    if (n < 0) return 0;
    path[n] = '\0';
    return strstr(path, "/dracon-canonical-writes-v1/dracon-canonical-write-v1-") != NULL;
}
ssize_t write(int fd, const void *data, size_t size) {
    ssize_t (*next)(int, const void *, size_t) = dlsym(RTLD_NEXT, "write");
    if (fail_stage(fd, "write")) { errno = ENOSPC; return -1; }
    return next(fd, data, size);
}
ssize_t writev(int fd, const struct iovec *iov, int count) {
    ssize_t (*next)(int, const struct iovec *, int) = dlsym(RTLD_NEXT, "writev");
    if (fail_stage(fd, "write")) { errno = ENOSPC; return -1; }
    return next(fd, iov, count);
}
int fsync(int fd) {
    int (*next)(int) = dlsym(RTLD_NEXT, "fsync");
    if (fail_stage(fd, "sync")) { errno = ENOSPC; return -1; }
    return next(fd);
}
