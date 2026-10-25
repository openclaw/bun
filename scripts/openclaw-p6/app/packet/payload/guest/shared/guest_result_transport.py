"""Non-TTY guest result transport; run_guest_vm keeps its serial.log contract."""
from dataclasses import dataclass
from pathlib import Path

@dataclass(frozen=True)
class GuestResultTransport:
    qemu_args: list[str]
    guest_redirect: str
    metadata: dict[str, str]
    artifacts: tuple[tuple[Path, str], ...]

def prepare_result_transport(work: Path) -> GuestResultTransport:
    port='org.openclaw.p6.result'
    result=work/'serial.log'
    console=work/'boot-console.log'
    for path in [result,console]: path.touch(mode=0o600,exist_ok=False)
    return GuestResultTransport(
        qemu_args=['-serial','file:'+str(console),'-device','virtio-serial-pci',
                   '-chardev','file,id=p6-result,path='+str(result),
                   '-device','virtserialport,chardev=p6-result,name='+port],
        guest_redirect='test -c /dev/virtio-ports/'+port+'; exec >/dev/virtio-ports/'+port+' 2>&1',
        metadata={'kind':'virtio-serial/non-TTY','vmOwnerReceiveFile':'serial.log',
                  'resultArtifact':'guest-result-stream.log','bootConsoleArtifact':'guest-boot-console.log',
                  'guestPort':port},
        artifacts=((result,'guest-result-stream.log'),(console,'guest-boot-console.log')),
    )
