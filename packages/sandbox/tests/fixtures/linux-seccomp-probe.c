#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <linux/vm_sockets.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <unistd.h>

int main(int argc, char **argv) {
  for (int fd = 3; fd < 64; fd++) {
    if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) return 19;
  }
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) return 10;
  int vsock = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (vsock >= 0 || errno != EPERM) return 11;
  int unix_socket = socket(AF_UNIX, SOCK_STREAM, 0);
  if (unix_socket >= 0 || errno != EPERM) return 18;
  const char *devices[] = {"/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"};
  for (size_t i = 0; i < sizeof(devices) / sizeof(devices[0]); i++) {
    int device = open(devices[i], O_RDONLY);
    if (device < 0) return 20;
    close(device);
  }
  if (access("/dev/mem", F_OK) == 0 || errno != ENOENT) return 21;
  if (argc > 2 && strcmp(argv[1], "connect-enabled") != 0) {
    char *end = NULL;
    long host_pid = strtol(argv[2], &end, 10);
    if (*end != '\0' || host_pid < 1 || kill((pid_t)host_pid, 0) == 0 || errno != ESRCH)
      return 22;
  }
  if (argc > 2 && strcmp(argv[1], "connect-enabled") == 0) {
    char *end = NULL;
    long port = strtol(argv[2], &end, 10);
    if (*end != '\0' || port < 1 || port > 65535) return 14;
    int tcp = socket(AF_INET, SOCK_STREAM, 0);
    if (tcp < 0) return 15;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons((unsigned short)port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(tcp, (struct sockaddr *)&address, sizeof(address)) != 0) return 16;
    if (write(tcp, "ok", 2) != 2) return 17;
    close(tcp);
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "network-disabled") == 0) {
    const int families[] = {AF_INET, AF_INET6};
    const int types[] = {SOCK_STREAM, SOCK_DGRAM};
    for (size_t family = 0; family < 2; family++) {
      for (size_t type = 0; type < 2; type++) {
        int socket_fd = socket(families[family], types[type], 0);
        if (socket_fd < 0) return 12;
        int status;
        if (families[family] == AF_INET) {
          struct sockaddr_in address = {0};
          address.sin_family = AF_INET;
          address.sin_port = htons(1);
          address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
          status = connect(socket_fd, (struct sockaddr *)&address, sizeof(address));
        } else {
          struct sockaddr_in6 address = {0};
          address.sin6_family = AF_INET6;
          address.sin6_port = htons(1);
          address.sin6_addr = in6addr_loopback;
          status = connect(socket_fd, (struct sockaddr *)&address, sizeof(address));
        }
        if (status == 0 || errno != EPERM) return 13;
        close(socket_fd);
      }
    }
  }
  return 0;
}
