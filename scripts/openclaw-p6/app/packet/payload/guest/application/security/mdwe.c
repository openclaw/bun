#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>
#ifndef PR_SET_MDWE
#define PR_SET_MDWE 65
#define PR_GET_MDWE 66
#define PR_MDWE_REFUSE_EXEC_GAIN 1
#define PR_MDWE_NO_INHERIT 2
#endif
long p6_get_mdwe(void) { errno=0; return prctl(PR_GET_MDWE, 0, 0, 0, 0); }
int p6_try_exec(void) {
 void *p=mmap(NULL,4096,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
 if(p==MAP_FAILED) return -errno;
#if defined(__aarch64__)
 const uint32_t code[]={0x52800540,0xd65f03c0};
#elif defined(__x86_64__)
 const unsigned char code[]={0xb8,42,0,0,0,0xc3};
#else
#error Unsupported architecture
#endif
 memcpy(p,code,sizeof(code));
 if(mprotect(p,4096,PROT_READ|PROT_EXEC)!=0){ int e=errno; munmap(p,4096); return -e; }
 __builtin___clear_cache(p,(char*)p+sizeof(code));
 int answer=((int(*)(void))p)(); munmap(p,4096); return answer;
}
int p6_try_rwx(void) {
 void *p=mmap(NULL,4096,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
 if(p==MAP_FAILED) return -errno;
 munmap(p,4096); return 0;
}
#ifndef P6_LIBRARY
int main(int argc,char **argv){
 if(argc>1 && strcmp(argv[1],"no-inherit")==0){if(prctl(PR_SET_MDWE,3,0,0,0)!=0){perror("PR_SET_MDWE");return 2;}}
 if(argc>1 && strcmp(argv[1],"inherit")==0){if(prctl(PR_SET_MDWE,1,0,0,0)!=0){perror("PR_SET_MDWE");return 2;}}
 printf("{\"mdwe\":%ld,\"rw_to_rx\":%d,\"rwx\":%d}\n",p6_get_mdwe(),p6_try_exec(),p6_try_rwx()); fflush(stdout);
 if(argc>2 && strcmp(argv[2],"child")==0){
  pid_t pid=fork();
  if(pid<0){perror("fork");return 2;}
  if(pid==0){execl(argv[0],argv[0],NULL);_exit(127);}
  int w;
  pid_t waited;
  do { waited=waitpid(pid,&w,0); } while(waited<0 && errno==EINTR);
  if(waited!=pid){perror("waitpid");return 2;}
  return WIFEXITED(w)?WEXITSTATUS(w):128+WTERMSIG(w);
 }
 return 0;
}
#endif
