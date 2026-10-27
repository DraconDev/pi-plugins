// Disposable fault schedule: pause ONLY the specified ordinary-file write,
// after native open/truncate. All unrelated I/O passes through unchanged.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/syscall.h>
#include <sys/uio.h>
static _Atomic int gated;
static void gate(int fd) {
    const char *target = getenv("PI_CANONICAL_GATE_TARGET");
    const char *ready = getenv("PI_CANONICAL_GATE_READY");
    const char *release = getenv("PI_CANONICAL_GATE_RELEASE");
    if (!target || !ready || !release) return;
    char proc[64], path[4096];
    snprintf(proc, sizeof(proc), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(proc, path, sizeof(path) - 1);
    if (n < 0) return;
    path[n] = 0;
    if (strcmp(target, path) || atomic_exchange(&gated, 1)) return;
    int marker = syscall(SYS_openat, AT_FDCWD, ready, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (marker >= 0) { syscall(SYS_write, marker, "ready\n", 6); syscall(SYS_close, marker); }
    // Finite even if the disposable controller fails. No host filesystem fill.
    for (int i = 0; i < 20000 && access(release, F_OK); i++) usleep(1000);
}
ssize_t write(int fd, const void *data, size_t size) {
    ssize_t (*next)(int, const void *, size_t) = dlsym(RTLD_NEXT, "write");
    gate(fd); return next(fd, data, size);
}
ssize_t writev(int fd, const struct iovec *iov, int count) {
    ssize_t (*next)(int, const struct iovec *, int) = dlsym(RTLD_NEXT, "writev");
    gate(fd); return next(fd, iov, count);
}
