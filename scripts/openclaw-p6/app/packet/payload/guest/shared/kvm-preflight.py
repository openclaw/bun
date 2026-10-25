#!/usr/bin/env python3
import fcntl,json,os,platform
result={'arch':platform.machine(),'kernel':platform.release(),'kvmDevice':'/dev/kvm','effectiveUid':os.geteuid(),'vmStarted':False}
fd=None
vm=None
try:
    fd=os.open('/dev/kvm',os.O_RDWR|os.O_CLOEXEC)
    result['apiVersion']=fcntl.ioctl(fd,0xAE00,0)
    if result['apiVersion']!=12: raise RuntimeError('Unsupported KVM API version')
    vm=fcntl.ioctl(fd,0xAE01,0)
    result['emptyVmCreated']=vm>=0
    os.close(vm);vm=None
    result['emptyVmClosed']=True
    result['pass']=True
except (OSError,RuntimeError) as error:
    result['pass']=False;result['error']=str(error)
finally:
    if vm is not None: os.close(vm)
    if fd is not None: os.close(fd)
print(json.dumps(result),flush=True)
raise SystemExit(0 if result['pass'] else 1)
