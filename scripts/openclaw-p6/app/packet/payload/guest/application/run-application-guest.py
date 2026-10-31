#!/usr/bin/env python3
"""Future admitted-artifact CLI proof; never builds or modifies an application."""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys

IMAGE_SHA = '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'
OWNER_SHA = 'bca0eac25f6bd828f67c895c675fea6c8202583b1e6027f6a83f22212860ab42'
TRANSPORT_SHA = '1e0d155a7827e3fa44e3c377d935001a3db6f6546cdc397fa909c86be4dcdd7b'


def digest(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact', type=Path, required=True)
    parser.add_argument('--admission-receipt', type=Path, required=True)
    parser.add_argument('--binary-sha256', required=True)
    parser.add_argument('--main-sha', required=True)
    parser.add_argument('--variant', choices=['js-aot', 'c2', 'ts-aot', 'c2-linux-hardened'], required=True)
    parser.add_argument('--expected-stdout', required=True)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--work-dir', type=Path, required=True)
    parser.add_argument('--vm-owner', type=Path, required=True)
    parser.add_argument('--prerequisites', type=Path, required=True)
    parser.add_argument('--prerequisites-sha256', required=True)
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        parser.error('requires the owned native Linux x64 host')
    if not re.fullmatch('[0-9a-f]{40}', args.main_sha) or not re.fullmatch('[0-9a-f]{64}', args.binary_sha256):
        parser.error('requires full admitted source and binary hashes')
    artifact = args.artifact.resolve(strict=True)
    work = args.work_dir.resolve()
    if work.exists() or work == artifact or artifact in work.parents:
        parser.error('work-dir must be fresh and outside the artifact')
    if not (artifact / 'runtime').is_dir() or not (artifact / 'manifest.json').is_file():
        parser.error('requires a complete standalone artifact with runtime and manifest')
    if digest(artifact / 'openclaw') != args.binary_sha256:
        parser.error('application differs from admitted binary hash')
    if digest(args.image) != IMAGE_SHA or digest(args.vm_owner) != OWNER_SHA:
        parser.error('cloud image or reviewed VM lifecycle owner hash differs')
    transport_file = args.vm_owner.with_name('guest_result_transport.py')
    if digest(transport_file) != TRANSPORT_SHA:
        parser.error('reviewed shared guest result transport hash differs')
    admission_sha = digest(args.admission_receipt)
    for entry in artifact.rglob('*'):
        if entry.is_symlink():
            if os.path.isabs(os.readlink(entry)) or not entry.resolve(strict=True).is_relative_to(artifact):
                parser.error('artifact link is not portable and contained: ' + str(entry))
        elif not entry.is_file() and not entry.is_dir():
            parser.error('artifact contains a non-regular payload entry: ' + str(entry))
    if digest(args.prerequisites) != args.prerequisites_sha256:
        parser.error('Guest prerequisite receipt changed')
    prerequisites = json.loads(args.prerequisites.read_text())
    if prerequisites['status'] != 'guest-prerequisites-present-not-kvm-qualified' or prerequisites['imageSha256'] != IMAGE_SHA:
        parser.error('Guest prerequisites incomplete')
    if set(prerequisites['tools']) != {'qemu-system-x86_64','qemu-img','cloud-localds','mkfs.ext4','timeout','sudo'}:
        parser.error('Guest prerequisite tool hash map incomplete')
    for tool, item in prerequisites['tools'].items():
        if shutil.which(tool) != item['path'] or digest(item['path']) != item['sha256']:
            parser.error('Guest host tool changed: ' + tool)
    for tool in ['qemu-system-x86_64', 'qemu-img', 'cloud-localds', 'mkfs.ext4', 'timeout', 'sudo']:
        if not shutil.which(tool):
            parser.error('host prerequisite absent: ' + tool)
    spec = importlib.util.spec_from_file_location('p6_vm_owner', args.vm_owner)
    owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner)
    transport_spec = importlib.util.spec_from_file_location('p6_guest_result_transport', transport_file)
    transport_owner = importlib.util.module_from_spec(transport_spec)
    sys.modules[transport_spec.name] = transport_owner
    transport_spec.loader.exec_module(transport_owner)
    preflight = subprocess.run(['sudo', '-n', 'python3', str(args.vm_owner.parent / 'kvm-preflight.py')],
                               capture_output=True, text=True, timeout=30, check=True)
    kvm = json.loads(preflight.stdout)
    if kvm.get('pass') is not True:
        parser.error('current host privileged KVM preflight did not pass')
    work.mkdir(parents=True, exist_ok=False)
    transport = transport_owner.prepare_result_transport(work)
    payload = work / 'payload'
    payload.mkdir()
    shutil.copytree(artifact, payload / 'artifact', symlinks=True)
    if digest(payload / 'artifact/openclaw') != args.binary_sha256:
        raise RuntimeError('Copied application differs from admitted binary')
    here = Path(__file__).resolve().parent
    for name in ['guest-cli.py', 'trace-policy.py', 'memory-policy.py']:
        shutil.copy2(here / name, payload / name)
    shutil.copytree(here / 'security', payload / 'security')
    controls = work / 'control-build'
    controls.mkdir()
    cc = shutil.which('cc', path='/usr/bin:/bin')
    if not cc:
        raise RuntimeError('Native fixture C compiler is absent; no application result')
    control_commands = []
    for source, library in [('mdwe.c', 'libp6mdwe.so'), ('file-exec.c', 'libp6fileexec.so')]:
        command = [cc, '-shared', '-fPIC', '-O2', '-DP6_LIBRARY', str(payload / 'security' / source), '-o', str(payload / 'security' / library)]
        control_commands.append(command)
        with (controls / (source + '.log')).open('wb') as output:
            subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, timeout=60, check=True, env={'PATH':'/usr/bin:/bin','TMPDIR':str(controls),'LANG':'C.UTF-8'})
    control_receipt = {'status':'native-x64-fixtures-built-not-app-proof','compiler':cc,'compilerSha256':digest(cc),'commands':control_commands,'sha256':{str(file.relative_to(payload / 'security')):digest(file) for file in (payload / 'security').rglob('*') if file.is_file()}}
    (controls / 'result.json').write_text(json.dumps(control_receipt, indent=2)+'\n')
    nonce = 'p6-app-' + args.variant + '-' + secrets.token_hex(8)
    manifest = {'nonce': nonce, 'variant': args.variant, 'mainSha': args.main_sha,
                'binarySha256': args.binary_sha256, 'admissionReceiptSha256': admission_sha,
                'artifactManifestSha256': digest(artifact / 'manifest.json'),
                'expectedStdout': args.expected_stdout, 'controlFiles':control_receipt['sha256'], 'prerequisitesSha256':args.prerequisites_sha256,
                'expectedMdwe': 1 if args.variant == 'c2-linux-hardened' else 3}
    (payload / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    payload_image = work / 'payload.ext4'
    size = sum(file.stat().st_size for file in payload.rglob('*') if file.is_file())
    with payload_image.open('wb') as stream:
        stream.truncate(((size + 128 * 1024**2) // (64 * 1024**2) + 1) * 64 * 1024**2)
    subprocess.run(['mkfs.ext4', '-q', '-F', '-L', 'P6APP', '-d', str(payload), str(payload_image)], check=True)
    config = {'datasource_list': ['NoCloud'], 'ssh_pwauth': False, 'disable_root': True, 'users': [],
              'ssh_deletekeys': True, 'ssh_genkeytypes': [], 'ssh_publish_hostkeys': {'enabled': False},
              'bootcmd': [['touch', '/etc/ssh/sshd_not_to_be_run']], 'network': {'config': 'disabled'},
              'runcmd': [['bash', '-c', 'exec >/var/tmp/p6-launch.log 2>&1; set -eu; udevadm settle --timeout=30; mkdir -p /mnt/p6; mount -o ro,nodev,nosuid /dev/disk/by-label/P6APP /mnt/p6; ' + transport.guest_redirect + '; python3 /mnt/p6/guest-cli.py']],
              'power_state': {'mode': 'poweroff', 'delay': 'now', 'timeout': 30, 'condition': True}}
    (work / 'user-data').write_text('#cloud-config\n' + json.dumps(config, indent=2) + '\n')
    (work / 'meta-data').write_text(json.dumps({'instance-id': nonce, 'local-hostname': 'p6-app-synthetic'}) + '\n')
    seed, overlay = work / 'seed.img', work / 'guest.qcow2'
    subprocess.run(['cloud-localds', str(seed), str(work / 'user-data'), str(work / 'meta-data')], check=True)
    subprocess.run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', str(args.image.resolve()), str(overlay)], check=True)
    subprocess.run(['qemu-img', 'resize', str(overlay), '8G'], check=True)
    command = ['sudo', '-n', 'env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'timeout', '--signal=TERM', '--kill-after=5s', '600s',
               'qemu-system-x86_64', '-accel', 'kvm', '-cpu', 'host', '-smp', '2', '-m', '4096', '-display', 'none', '-monitor', 'none',
               '-pidfile', str(work / 'qemu.pid'), *transport.qemu_args,
               '-qmp', 'unix:' + str(work / 'qmp.sock') + ',server=on,wait=off', '-no-reboot', '-nic', 'none',
               '-drive', 'file=' + str(overlay) + ',if=virtio,format=qcow2',
               '-drive', 'file=' + str(seed) + ',if=virtio,format=raw,readonly=on',
               '-drive', 'file=' + str(payload_image) + ',if=virtio,format=raw,readonly=on']
    report = {**manifest, 'command': command, 'cloudImageSha256': IMAGE_SHA, 'vmOwnerSha256': OWNER_SHA,
              'guestResultTransportSha256': TRANSPORT_SHA, 'resultTransport': transport.metadata,
              'hostKvmPreflight': kvm, 'pass': False, 'applicationQualification': False,
              'scope': 'Actual application CLI/main-thread MDWE memory controls; Gateway, workers and performance remain separate.'}
    owner.run_guest_vm(command, work, overlay, report)
    for source, name in transport.artifacts:
        shutil.copy2(source, work / name)
    (work / 'application-guest-result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'pass': report['pass'], 'result': str(work / 'application-guest-result.json')}))
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
