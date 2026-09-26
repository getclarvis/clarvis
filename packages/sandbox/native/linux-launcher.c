#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/vm_sockets.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define CLARVIS_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define CLARVIS_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported Linux architecture
#endif

#define DENY_SYSCALL(number) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

static int make_filter(int network_disabled) {
  struct sock_filter filter[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, CLARVIS_AUDIT_ARCH, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef __NR_ptrace
      DENY_SYSCALL(__NR_ptrace),
#endif
#ifdef __NR_bpf
      DENY_SYSCALL(__NR_bpf),
#endif
#ifdef __NR_keyctl
      DENY_SYSCALL(__NR_keyctl),
#endif
#ifdef __NR_mount
      DENY_SYSCALL(__NR_mount),
#endif
#ifdef __NR_umount2
      DENY_SYSCALL(__NR_umount2),
#endif
#ifdef __NR_setns
      DENY_SYSCALL(__NR_setns),
#endif
#ifdef __NR_unshare
      DENY_SYSCALL(__NR_unshare),
#endif
#ifdef __NR_perf_event_open
      DENY_SYSCALL(__NR_perf_event_open),
#endif
#ifdef __NR_io_uring_setup
      DENY_SYSCALL(__NR_io_uring_setup),
#endif
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 6),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_VSOCK, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  size_t count = sizeof(filter) / sizeof(filter[0]);
  if (network_disabled) {
    struct sock_filter extra[] = {
#ifdef __NR_connect
        DENY_SYSCALL(__NR_connect),
#endif
#ifdef __NR_bind
        DENY_SYSCALL(__NR_bind),
#endif
#ifdef __NR_listen
        DENY_SYSCALL(__NR_listen),
#endif
#ifdef __NR_accept
        DENY_SYSCALL(__NR_accept),
#endif
#ifdef __NR_accept4
        DENY_SYSCALL(__NR_accept4),
#endif
    };
    size_t base_end = count - 8;
    size_t extra_count = sizeof(extra) / sizeof(extra[0]);
    struct sock_filter *combined = calloc(count + extra_count, sizeof(*combined));
    if (!combined) return -1;
    memcpy(combined, filter, base_end * sizeof(*filter));
    memcpy(combined + base_end, extra, extra_count * sizeof(*extra));
    memcpy(combined + base_end + extra_count, filter + base_end,
           8 * sizeof(*filter));
    int fd = syscall(SYS_memfd_create, "clarvis-seccomp", 0);
    if (fd < 0 || write(fd, combined, (count + extra_count) * sizeof(*combined)) !=
                      (ssize_t)((count + extra_count) * sizeof(*combined)) ||
        lseek(fd, 0, SEEK_SET) < 0) {
      free(combined);
      if (fd >= 0) close(fd);
      return -1;
    }
    free(combined);
    return fd;
  }
  int fd = syscall(SYS_memfd_create, "clarvis-seccomp", 0);
  if (fd < 0 || write(fd, filter, sizeof(filter)) != (ssize_t)sizeof(filter) ||
      lseek(fd, 0, SEEK_SET) < 0) {
    if (fd >= 0) close(fd);
    return -1;
  }
  return fd;
}

int main(int argc, char **argv) {
  if (argc < 5 || (strcmp(argv[1], "--network-enabled") != 0 &&
                   strcmp(argv[1], "--network-disabled") != 0)) {
    fputs("invalid launcher arguments\n", stderr);
    return 64;
  }
  int network_disabled = strcmp(argv[1], "--network-disabled") == 0;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    perror("no_new_privs");
    return 70;
  }
  int fd = make_filter(network_disabled);
  if (fd < 0 || dup2(fd, 3) < 0) {
    perror("seccomp filter");
    return 70;
  }
  if (fd != 3) close(fd);
  size_t boundary = 0;
  for (int i = 3; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      boundary = (size_t)i;
      break;
    }
  }
  if (boundary == 0) return 64;
  char **args = calloc((size_t)argc + 3, sizeof(*args));
  if (!args) return 70;
  size_t out = 0;
  args[out++] = argv[2];
  for (size_t i = 3; i < boundary; i++) args[out++] = argv[i];
  args[out++] = "--seccomp";
  args[out++] = "3";
  for (size_t i = boundary; i < (size_t)argc; i++) args[out++] = argv[i];
  args[out] = NULL;
  execv(argv[2], args);
  perror("exec bwrap");
  return 70;
}
