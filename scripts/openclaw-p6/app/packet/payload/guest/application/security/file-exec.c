#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#ifndef MFD_EXEC
#define MFD_EXEC 0x0010U
#endif
int p6_file_private_rx(void) {
#if defined(__aarch64__)
  const uint32_t code[]={0x52800540,0xd65f03c0};
#elif defined(__x86_64__)
  const unsigned char code[]={0xb8,42,0,0,0,0xc3};
#else
#error Unsupported architecture
#endif
  int fd=memfd_create("p6-synthetic-code",MFD_CLOEXEC|MFD_EXEC);
  if(fd<0) return -errno;
  if(ftruncate(fd,4096)!=0 || write(fd,code,sizeof(code))!=(ssize_t)sizeof(code)) {
    int e=errno; close(fd); return -e;
  }
  void *p=mmap(NULL,4096,PROT_READ|PROT_EXEC,MAP_PRIVATE,fd,0);
  int e=errno; close(fd);
  if(p==MAP_FAILED) return -e;
  __builtin___clear_cache(p,(char*)p+sizeof(code));
  int result=((int(*)(void))p)(); munmap(p,4096); return result;
}
