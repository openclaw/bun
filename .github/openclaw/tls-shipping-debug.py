"""Build typed TLS diagnostic bytes with the frozen shipping optimization and ICU inputs."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = Path('/work')
SOURCE = ROOT / 'source'
ENGINE = ROOT / 'engine'
OUT = ROOT / 'diagnostics'
BUN = '454a78a4d3b0202ecdbedf7dd051fc84ffc59e9e'
WEBKIT = 'b82bc917e99110b61c3a21202d6def7457aa194c'
FIXTURE = 'test/js/bun/net/socket-retention.test.ts'
FIXTURE_SHA = 'd4c04a72b89bc7d33c292a16a57c38f5da540815dc2e141adfd58c1bd9973af2'
LANE = 'bun-webkit-linux-arm64-lto.tar.gz'
BUILD = SOURCE / 'build/tls-arm64-shipping-debug'
MANIFEST = SOURCE / 'scripts/build/deps/webkit-artifacts.json'
LIBS = ['libJavaScriptCore.a', 'libWTF.a', 'libbmalloc.a']
ENV = {key: value for key, value in os.environ.items()
       if key not in ('GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN')}
ENV.update(CI='true', CARGO_BUILD_JOBS='2')


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(name, value):
    with (OUT / name).open('x') as stream:
        stream.write(json.dumps(value, indent=2) + '\n')


def run(argv, name, cwd=SOURCE, env=ENV, timeout=120):
    with (OUT / name).open('x') as stream:
        subprocess.run(argv, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT,
                       check=True, timeout=timeout)


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()


def fetch(url, path, digest):
    assert not path.exists()
    with urllib.request.urlopen(url, timeout=120) as response, path.open('xb') as output:
        shutil.copyfileobj(response, output)
    assert sha(path) == digest, 'download checksum mismatch'


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        assert not path.is_symlink(), 'unexpected bundle symlink'
        if path.is_file():
            result[str(path.relative_to(root))] = sha(path)
    return result


assert os.uname().machine == 'aarch64'
assert git(SOURCE, 'rev-parse', 'HEAD') == BUN and not git(SOURCE, 'diff', '--name-only', 'HEAD')
assert git(ENGINE, 'rev-parse', 'HEAD') == WEBKIT and not git(ENGINE, 'diff', '--name-only', 'HEAD')
assert sha(SOURCE / FIXTURE) == FIXTURE_SHA
manifest_bytes = MANIFEST.read_bytes()
original_manifest = json.loads(manifest_bytes)
assert original_manifest['version'] == WEBKIT
artifact = original_manifest['artifacts'][LANE]
assert artifact['url'] == f'https://github.com/openclaw/WebKit/releases/download/autobuild-{WEBKIT}/{LANE}'
write('inputs.json', {'bun': BUN, 'webkit': WEBKIT, 'fixture_sha256': FIXTURE_SHA,
                      'shipping_archive': artifact, 'variance': 'full debug information; native build host',
                      'build_timeout_seconds': {'engine': 7200, 'bun': 7200},
                      'optimization': 'Release O3, ThinLTO, armv8-a+crc, ampere1, original allocator/assertion settings',
                      'icu': 'original bundled libraries, headers and filtered/repacked data; never system ICU'})
original = ROOT / LANE
fetch(artifact['url'], original, artifact['sha256'])
bundle_root = ROOT / 'shipping-bundle'
bundle_root.mkdir()
with tarfile.open(original) as archive:
    archive.extractall(bundle_root, filter='data')
bundle = bundle_root / 'bun-webkit'
assert bundle.is_dir() and all((bundle / 'lib' / name).is_file() for name in LIBS)
before = inventory(bundle)
assert all('lib/' + name in before for name in ['libicudata.a', 'libicui18n.a', 'libicuuc.a'])
assert any(name.endswith('/uvernum.h') for name in before)
write('shipping-bundle.json', before)

# The shell's decoder source matches the frozen engine recipe. ICU itself is not rebuilt.
zstd = ROOT / 'zstd-1.5.7.tar.gz'
fetch('https://github.com/meta/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz', zstd,
      'eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3')
with tarfile.open(zstd) as archive:
    archive.extractall(ROOT / 'zstd-source', filter='data')
sysroot = Path('/opt/linux-sysroot-glibc-arm64')
assert (sysroot / 'usr/lib/gcc/aarch64-linux-gnu/13/libstdc++.a').is_file()
compiler = subprocess.check_output(['clang', '--version'], text=True, env=ENV)
assert '23.1.1' in compiler, compiler
write('toolchain.json', {'compiler': compiler, 'sysroot': str(sysroot),
                         'libstdc++': sha(sysroot / 'usr/lib/gcc/aarch64-linux-gnu/13/libstdc++.a'),
                         'profile': sha(Path('/etc/profile.d/bun-ci.sh'))})
base_flags = (f'--sysroot={sysroot} --target=aarch64-unknown-linux-gnu -march=armv8-a+crc -mtune=ampere1 '
              '-mno-omit-leaf-frame-pointer -g -fno-omit-frame-pointer -ffunction-sections -fdata-sections '
              '-faddrsig -fno-unwind-tables -fno-asynchronous-unwind-tables -DU_STATIC_IMPLEMENTATION=1 '
              '-stdlib=libstdc++ -g -flto=thin -fno-split-lto-unit -fwhole-program-vtables -fforce-emit-vtables '
              '-ffile-prefix-map=/work/engine/Source=vendor/WebKit/Source -ffile-prefix-map=/work/jsc-build/=. ')
engine_env = ENV.copy()
for name in ('C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH', 'LD_LIBRARY_PATH', 'CFLAGS', 'CXXFLAGS'):
    engine_env.pop(name, None)
engine_env.update(CC='clang', CXX='clang++', LDFLAGS='-fuse-ld=lld')
engine_build = ROOT / 'jsc-build'
argv = ['cmake', '-S', str(ENGINE), '-B', str(engine_build), '-G', 'Ninja',
        '-DCMAKE_SYSTEM_NAME=Linux', '-DCMAKE_SYSTEM_PROCESSOR=aarch64', f'-DCMAKE_SYSROOT={sysroot}',
        '-DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER', '-DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH',
        '-DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH', '-DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH',
        '-DPORT=JSCOnly', '-DENABLE_STATIC_JSC=ON', '-DENABLE_BUN_SKIP_FAILING_ASSERTIONS=ON',
        '-DCMAKE_BUILD_TYPE=Release', '-DUSE_THIN_ARCHIVES=OFF', '-DUSE_BUN_JSC_ADDITIONS=ON',
        '-DUSE_BUN_EVENT_LOOP=ON', '-DENABLE_FTL_JIT=ON', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
        '-DALLOW_LINE_AND_COLUMN_NUMBER_IN_BUILTINS=ON', '-DENABLE_REMOTE_INSPECTOR=ON',
        '-DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=lld', '-DCMAKE_AR=' + shutil.which('llvm-ar'),
        '-DCMAKE_RANLIB=' + shutil.which('llvm-ranlib'), '-DCMAKE_C_FLAGS=' + base_flags,
        '-DCMAKE_CXX_FLAGS=' + base_flags + ' -fno-c++-static-destructors',
        '-DCMAKE_C_FLAGS_RELEASE=-O3 -DNDEBUG=1', '-DCMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG=1',
        '-DICU_ROOT=' + str(bundle), '-DBUN_ICU_ZSTD_SOURCE_DIR=/work/zstd-source/zstd-1.5.7/lib',
        '-DICU_INCLUDE_DIR=' + str(bundle / 'include'),
        '-DICU_UC_LIBRARY_RELEASE=' + str(bundle / 'lib/libicuuc.a'),
        '-DICU_I18N_LIBRARY_RELEASE=' + str(bundle / 'lib/libicui18n.a'),
        '-DICU_DATA_LIBRARY_RELEASE=' + str(bundle / 'lib/libicudata.a'),
        '-DENABLE_SANITIZERS=', '-DENABLE_ASSERTS=AUTO', '-DENABLE_FUZZILLI=OFF',
        '-DUSE_MIMALLOC=ON', '-DUSE_EXTERNAL_MIMALLOC=ON']
write('engine-build-command.json', {'argv': argv, 'compiler': 'clang/clang++ 23.1.1',
                                   'linker_flags': '-fuse-ld=lld'})
def header_comparison_bytes(name, path, shipping):
    # The pinned packager adds a version after compilation; offlineasm embeds its Ruby-source hash.
    if path.stat().st_size > 16 * 1024**2:
        return None
    data = path.read_bytes()
    if name == 'include/cmakeconfig.h':
        if shipping:
            stamp = ('\n#define BUN_WEBKIT_VERSION "' + WEBKIT + '"\n').encode()
            return data[:-len(stamp)] if data.endswith(stamp) else None
        return data
    provenance = {
        'include/JavaScriptCore/LLIntDesiredSettings.h': (0, b'// SettingsExtractor input hash: '),
        'include/JavaScriptCore/LLIntDesiredOffsets.h': (0, b'// OffsetExtractor input hash: '),
        'include/JavaScriptCore/LLIntAssembly.h': (-1, b'// offlineasm input hash: '),
    }
    if name not in provenance:
        return None
    index, prefix = provenance[name]
    lines = data.splitlines(keepends=True)
    observed = (b'23ac489dfebf7c9e22c7bc44e6826b164320e3d9' if shipping
                else b'0c288d42d6b2ddc755f5b6e880f0cc180650c33f')
    token = b' ' + observed + b' '
    if not lines or not lines[index].startswith(prefix) or lines[index].count(token) != 1:
        return None
    lines[index] = lines[index].replace(token, b' <offlineasm-self-hash> ', 1)
    return b''.join(lines)


def check_headers(headers, phase):
    missing = [str(name) for name in headers if str(name) not in before]
    mismatched = {str(name): {'shipping': before[str(name)], 'rebuilt': sha(path)}
                  for name, path in headers.items() if str(name) in before and sha(path) != before[str(name)]}
    raw_mismatched = dict(mismatched)
    provenance_only = {}
    for name in raw_mismatched:
        original = header_comparison_bytes(name, bundle / name, True)
        rebuilt = header_comparison_bytes(name, headers[Path(name)], False)
        if original is not None and rebuilt is not None and original == rebuilt:
            provenance_only[name] = {**mismatched.pop(name),
                                     'comparison_sha256': hashlib.sha256(original).hexdigest()}
    evidence = {}
    evidence_bytes = 0
    for name in sorted(raw_mismatched)[:4]:
        paths = {'shipping': bundle / name, 'rebuilt': headers[Path(name)]}
        size = sum(path.stat().st_size for path in paths.values())
        if evidence_bytes + size > 128 * 1024**2:
            evidence[name] = {'omitted': 'header evidence exceeds 128 MiB'}
            continue
        evidence[name] = {}
        for kind, path in paths.items():
            destination = OUT / 'header-evidence' / phase / (name + '.' + kind)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
            evidence[name][kind] = {'path': str(destination.relative_to(OUT)),
                                    'bytes': path.stat().st_size, 'sha256': sha(destination)}
        evidence_bytes += size
        # Retain large raw headers, but bound the in-memory line comparison separately.
        if size > 8 * 1024**2:
            evidence[name]['diff'] = {'omitted': 'diff inputs exceed 8 MiB'}
            continue
        destination = OUT / 'header-evidence' / phase / (name + '.diff')
        difference_bytes = 0
        with destination.open('xb') as stream:
            for line in difflib.unified_diff(
                    paths['shipping'].read_text().splitlines(keepends=True),
                    paths['rebuilt'].read_text().splitlines(keepends=True),
                    fromfile='shipping/' + name, tofile='rebuilt/' + name):
                content = line.encode()
                if evidence_bytes + difference_bytes + len(content) > 128 * 1024**2:
                    break
                stream.write(content)
                difference_bytes += len(content)
            else:
                stream.flush()
                evidence[name]['diff'] = {'path': str(destination.relative_to(OUT)),
                                          'bytes': difference_bytes, 'sha256': sha(destination)}
        if 'diff' not in evidence[name]:
            destination.unlink()
            evidence[name]['diff'] = {'omitted': 'diff exceeds remaining evidence budget'}
        else:
            evidence_bytes += difference_bytes
    write(phase + '-header-parity.json', {'files': len(headers), 'missing': missing,
                                         'mismatched': mismatched, 'provenance_only': provenance_only,
                                         'raw_mismatched': raw_mismatched, 'evidence': evidence})
    assert not missing and not mismatched, 'rebuilt core headers differ from the shipping consumer headers'


run(argv, 'engine-configure.log', cwd=ROOT, env=engine_env, timeout=600)
try:
    # These generated headers can reject an incompatible rebuild before compiling the core libraries.
    run(['cmake', '--build', str(engine_build), '--config', 'Release', '--parallel', '2',
         '--target', 'JavaScriptCore/DerivedSources/LLIntAssembly.h'],
        'engine-header-build.log', cwd=ROOT, env=engine_env, timeout=1200)
    early_headers = {Path('include/cmakeconfig.h'): engine_build / 'cmakeconfig.h'}
    for name in ('LLIntAssembly.h', 'LLIntDesiredOffsets.h', 'LLIntDesiredSettings.h'):
        early_headers[Path('include/JavaScriptCore') / name] = engine_build / 'JavaScriptCore/DerivedSources' / name
    assert all(path.is_file() for path in early_headers.values()), 'generated header preflight incomplete'
    check_headers(early_headers, 'generated')
    run(['cmake', '--build', str(engine_build), '--config', 'Release', '--parallel', '2',
         '--target', 'jsc', '--target', 'testFFI'], 'engine-build.log', cwd=ROOT, env=engine_env, timeout=7200)
finally:
    for name in ('CMakeCache.txt', 'compile_commands.json'):
        if (engine_build / name).is_file():
            shutil.copyfile(engine_build / name, OUT / name)
run(['python3', str(ENGINE / 'Tools/Scripts/check-classinfo-uniqueness.py'), str(engine_build / 'bin/jsc')],
    'engine-classinfo.log', cwd=ROOT)
elf = subprocess.check_output(['readelf', '-h', str(engine_build / 'bin/jsc')], text=True)
dynamic = subprocess.check_output(['readelf', '-d', str(engine_build / 'bin/jsc')], text=True)
versions = subprocess.check_output(['readelf', '--version-info', str(engine_build / 'bin/jsc')], text=True)
glibc = [tuple(map(int, value.split('.'))) for value in re.findall(r'GLIBC_([0-9]+\.[0-9]+)', versions)]
assert 'AArch64' in elf and 'libm.so.6' in dynamic and glibc and max(glibc) <= (2, 31)
assert not re.search(r'NEEDED.*libicu', dynamic)
write('engine-binary.json', {'ELF': elf, 'dynamic': dynamic, 'max_glibc': max(glibc)})
run([str(engine_build / 'bin/jsc'), '-e', 'if(1+1!==2)throw Error("startup");print(new Intl.DateTimeFormat("ja-JP-u-ca-japanese").format(new Date(0)))'],
    'engine-startup.log', cwd=ROOT)

# The prebuilt consumer must use the same headers as these rebuilt core libraries.
# Match the frozen Dockerfile's flattening order, retaining its ICU headers untouched.
headers = {Path('include') / path.name: path for path in engine_build.glob('*.h')}
for directory in ('JavaScriptCore/DerivedSources', 'JavaScriptCore/Headers/JavaScriptCore',
                  'JavaScriptCore/PrivateHeaders/JavaScriptCore'):
    parent = engine_build / directory
    assert parent.is_dir(), 'missing core header directory: ' + directory
    for path in sorted(parent.rglob('*.h')):
        headers[Path('include/JavaScriptCore') / path.name] = path
for directory, destination in [('WTF/Headers/wtf', 'include/wtf'), ('bmalloc/Headers/bmalloc', 'include/bmalloc')]:
    parent = engine_build / directory
    assert parent.is_dir(), 'missing core header directory: ' + directory
    for path in sorted(parent.rglob('*')):
        if path.is_file():
            headers[Path(destination) / path.relative_to(parent)] = path
assert headers
check_headers(headers, 'core')
for name in LIBS:
    shutil.copyfile(engine_build / 'lib' / name, bundle / 'lib' / name)
after = inventory(bundle)
assert before.keys() == after.keys()
assert {name for name in before if before[name] != after[name]} == {'lib/' + name for name in LIBS}
write('adapted-bundle.json', after)

# Give these diagnostic bytes their own digest and task-owned prefetch/cache. Never reuse the shipping checksum.
rebuilt = ROOT / 'debug-webkit.tar.gz'
with tarfile.open(rebuilt, 'w:gz') as archive:
    archive.add(bundle, arcname='bun-webkit')
digest = sha(rebuilt)
prefetch = ROOT / 'debug-prefetch/by-sha256'
prefetch.mkdir(parents=True)
rebuilt.rename(prefetch / digest)
flags = SOURCE / 'scripts/build/flags.ts'
text = flags.read_text()
flags_bytes = flags.read_bytes()
assert text.count('flag: "-g1",') == 1
flags.write_text(text.replace('flag: "-g1",', 'flag: "-g",'))
manifest = json.loads(MANIFEST.read_text())
manifest['artifacts'][LANE]['sha256'] = digest
MANIFEST.write_text(json.dumps(manifest, indent=2) + '\n')
write('diagnostic-overlay.json', {'archive_sha256': digest, 'manifest_sha256': sha(MANIFEST),
                                   'flags_sha256': sha(flags), 'shipping_archive_sha256': artifact['sha256']})
patch = subprocess.check_output(['git', '-C', str(SOURCE), 'diff', '--binary', 'HEAD'])
(OUT / 'diagnostic-build.patch').write_bytes(patch)
env = ENV.copy()
env.update(BUN_BUILD_PREFETCH_DIR='/work/debug-prefetch', BUN_BUILD_CACHE_DIR='/work/debug-cache')
argv = ['bun', 'scripts/build.ts', '--profile=release', '--ci=on', '--os=linux', '--arch=aarch64',
        '--abi=gnu', '--lto=on', '--webkit=prebuilt', '--build-dir=' + str(BUILD), '-j2', '--timings']
write('bun-build-command.json', {'argv': argv})
try:
    run(argv, 'bun-build.log', env=env, timeout=7200)
finally:
    assert sha(SOURCE / FIXTURE) == FIXTURE_SHA
    assert git(SOURCE, 'diff', '--name-only', 'HEAD').splitlines() == [
        'scripts/build/deps/webkit-artifacts.json', 'scripts/build/flags.ts']
    assert sha(MANIFEST) == json.loads((OUT / 'diagnostic-overlay.json').read_text())['manifest_sha256']
    assert sha(flags) == json.loads((OUT / 'diagnostic-overlay.json').read_text())['flags_sha256']
    MANIFEST.write_bytes(manifest_bytes)
    flags.write_bytes(flags_bytes)
    assert not git(SOURCE, 'diff', '--name-only', 'HEAD')
binary, profile = BUILD / 'bun', BUILD / 'bun-profile'
for path in (binary, profile):
    assert path.is_file()
    run(['readelf', '-n', str(path)], path.name + '-build-id.txt', cwd=ROOT)
write('executables.json', {str(path.relative_to(ROOT)): {'sha256': sha(path), 'bytes': path.stat().st_size}
                          for path in (binary, profile)})
run([str(binary), '-e', 'console.log(JSON.stringify({bun:Bun.revision,webkit:process.versions.webkit,platform:process.platform,arch:process.arch}))'], 'runtime.json')
assert json.loads((OUT / 'runtime.json').read_text()) == {'bun': BUN, 'webkit': WEBKIT, 'platform': 'linux', 'arch': 'arm64'}
