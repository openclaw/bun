#!/usr/bin/env python3
"""Preserve a successful P6 native artifact, then verify its relocated copy."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tarfile

SOURCE_COMMIT = '59baf4a051665750eb7055d0cec991d9876526df'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(filename):
    digest = hashlib.sha256()
    with Path(filename).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_pinned(filename, digest):
    data = Path(filename).read_bytes()
    require(hashlib.sha256(data).hexdigest() == digest, 'Input hash mismatch: ' + str(filename))
    return data


def write_json(filename, value):
    Path(filename).write_text(json.dumps(value, indent=2) + '\n')


def contained(root, child):
    try:
        Path(child).relative_to(root)
        return True
    except ValueError:
        return False


def inventory(root):
    """Transport metadata only; content/tree hashes remain with the source owner."""
    rows = [{'path': '.', 'kind': 'directory', 'mode': stat.S_IMODE(root.stat().st_mode)}]
    def visit(directory):
        for item in sorted(directory.iterdir(), key=lambda p: p.name):
            info = item.lstat()
            row = {'path': item.relative_to(root).as_posix(), 'mode': stat.S_IMODE(info.st_mode)}
            if stat.S_ISLNK(info.st_mode):
                row.update(kind='symlink', target=os.readlink(item))
                require(not Path(row['target']).is_absolute() and contained(root, item.resolve(strict=True)),
                        'Artifact link is not relocatable: ' + row['path'])
            elif stat.S_ISDIR(info.st_mode):
                row['kind'] = 'directory'
            elif stat.S_ISREG(info.st_mode):
                row.update(kind='file', size=info.st_size)
            else:
                raise ValueError('Unsupported artifact member: ' + row['path'])
            rows.append(row)
            if row['kind'] == 'directory':
                visit(item)
    visit(root)
    return rows


def inputs(plan_file, plan_sha, result_file, result_sha):
    plan_data = read_pinned(plan_file, plan_sha)
    result_data = read_pinned(result_file, result_sha)
    plan, result = json.loads(plan_data), json.loads(result_data)
    require(result['status'] == 'built-unsigned' and result['phase'] == 'complete' and
            result['measurement']['exitCode'] == 0, 'No successful completed native build')
    require(result['plan'] == plan, 'Result does not contain the exact native plan')
    require(plan['platform'] == 'linux' and plan['arch'] == 'x64' and
            plan['sourceProof']['commit'] == SOURCE_COMMIT, 'Wrong native target or final source cut')
    return plan_data, result_data, plan, result


def check_artifact(plan_file, plan, result, checker, node, logs):
    checker, node = Path(checker).resolve(), Path(node).resolve()
    require(sha(checker) == plan['artifactCheckerSha256'], 'Artifact checker changed')
    owner = Path(plan['source']) / 'scripts/lib/bun-standalone-contract.mjs'
    require(sha(owner) == result['artifact']['contractOwnerSha256'], 'Source contract owner changed')
    env = {'PATH': str(node.parent) + ':/usr/bin:/bin', 'HOME': str(logs),
           'TMPDIR': str(logs), 'LANG': 'C.UTF-8', 'NODE_NO_WARNINGS': '1'}
    process = subprocess.run([str(node), str(checker), str(plan_file)], env=env,
                             cwd=logs, capture_output=True, text=True, timeout=1800)
    (logs / 'checker.stdout').write_text(process.stdout)
    (logs / 'checker.stderr').write_text(process.stderr)
    require(process.returncode == 0, 'Artifact owner check failed; see checker.stderr')
    actual = json.loads(process.stdout)
    require(actual == result['artifact'], 'Relocated owner facts differ from native result')
    return actual


def fresh_output(output, protected):
    output = Path(output).resolve()
    require(not output.exists(), 'Output already exists')
    require(all(not contained(Path(root).resolve(), output) for root in protected),
            'Preservation output must be outside source and artifact')
    output.mkdir(parents=True)
    return output


def pack(args):
    plan_data, result_data, plan, result = inputs(args.plan, args.plan_sha256,
                                                args.result, args.result_sha256)
    artifact = Path(plan['output']).resolve(strict=True)
    require(artifact.is_dir() and not Path(plan['output']).is_symlink(), 'Artifact root is not a directory')
    require(sha(plan['buildNode']['path']) == plan['buildNode']['sha256'], 'Admitted native Node changed')
    output = fresh_output(args.out, [artifact, plan['source']])
    for name, data in [('native-plan.json', plan_data), ('native-result.json', result_data)]:
        (output / name).write_bytes(data)
    facts = check_artifact(output / 'native-plan.json', plan, result, args.checker,
                           plan['buildNode']['path'], output)
    metadata = inventory(artifact)
    write_json(output / 'artifact-metadata.json', metadata)
    archive = output / 'artifact.tar'
    with tarfile.open(archive, 'w', dereference=False, format=tarfile.PAX_FORMAT) as bundle:
        bundle.add(artifact, arcname='artifact', recursive=True)
        for name in ['native-plan.json', 'native-result.json', 'artifact-metadata.json']:
            bundle.add(output / name, arcname=name, recursive=False)
    require(sha(args.plan) == args.plan_sha256 and sha(args.result) == args.result_sha256,
            'Native plan/result changed during preservation')
    receipt = {'status': 'preserved-not-downloaded', 'sourceCommit': SOURCE_COMMIT,
               'archive': str(archive), 'archiveSha256': sha(archive),
               'archiveBytes': archive.stat().st_size, 'helperSha256': sha(__file__),
               'nativePlanSha256': args.plan_sha256, 'nativeResultSha256': args.result_sha256,
               'checkerSha256': plan['artifactCheckerSha256'],
               'contractOwnerSha256': facts['contractOwnerSha256'],
               'manifestSha256': facts['manifestSha256'], 'executable': facts['executable'],
               'runtime': facts['runtime'], 'artifactMetadataSha256': sha(output / 'artifact-metadata.json')}
    write_json(output / 'transport.json', receipt)
    return receipt


def validate_members(members):
    names, links = set(), set()
    allowed = {'native-plan.json', 'native-result.json', 'artifact-metadata.json'}
    for member in members:
        name = PurePosixPath(member.name)
        require(not name.is_absolute() and '..' not in name.parts and member.name not in names,
                'Unsafe or duplicate archive path')
        require(name.parts and (name.parts[0] == 'artifact' or str(name) in allowed), 'Unexpected archive root')
        require(member.isdir() or member.isfile() or member.issym() or member.islnk(), 'Special archive member')
        names.add(member.name)
        if member.issym():
            target = PurePosixPath(member.linkname)
            require(not target.is_absolute(), 'Absolute archive symlink')
            normalized = os.path.normpath(str(name.parent / target))
            require(normalized == 'artifact' or normalized.startswith('artifact/'), 'Escaping archive symlink')
            links.add(member.name)
        if member.islnk():
            target = PurePosixPath(member.linkname)
            require(not target.is_absolute() and '..' not in target.parts and target.parts[0] == 'artifact',
                    'Escaping archive hardlink')
    for name in names:
        require(not any(str(parent) in links for parent in PurePosixPath(name).parents),
                'Archive member traverses a symlink')


def verify(args):
    receipt = json.loads(read_pinned(args.transport, args.transport_sha256))
    require(receipt['status'] == 'preserved-not-downloaded' and
            receipt['sourceCommit'] == SOURCE_COMMIT and receipt['helperSha256'] == sha(__file__),
            'Wrong transport receipt or helper')
    require(args.archive_sha256 == receipt['archiveSha256'] and
            sha(args.archive) == receipt['archiveSha256'] and
            Path(args.archive).stat().st_size == receipt['archiveBytes'], 'Archive transfer differs')
    source = Path(args.source).resolve(strict=True)
    head = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    require(head == SOURCE_COMMIT, 'Local carrier is not the final source cut')
    output = fresh_output(args.out, [source])
    with tarfile.open(args.archive, 'r:') as bundle:
        validate_members(bundle.getmembers())
        # Validated paths and links above; retain exact modes across Python defaults.
        if hasattr(tarfile, 'fully_trusted_filter'):
            bundle.extractall(output, filter=tarfile.fully_trusted_filter)
        else:
            bundle.extractall(output)
    plan_data, result_data, native_plan, result = inputs(output / 'native-plan.json', receipt['nativePlanSha256'],
                                                       output / 'native-result.json', receipt['nativeResultSha256'])
    require(sha(output / 'artifact-metadata.json') == receipt['artifactMetadataSha256'], 'Metadata transfer differs')
    require(inventory(output / 'artifact') == json.loads((output / 'artifact-metadata.json').read_text()),
            'Artifact paths, kinds, modes, sizes, or link targets changed')
    derived = copy.deepcopy(native_plan)
    derived['source'], derived['output'] = str(source), str(output / 'artifact')
    write_json(output / 'local-check-plan.json', derived)
    facts = check_artifact(output / 'local-check-plan.json', derived, result, args.checker, args.node, output)
    report = {'status': 'downloaded-and-verified', 'applicationQualified': False,
              'sourceCommit': SOURCE_COMMIT, 'archiveSha256': receipt['archiveSha256'],
              'nativePlanSha256': receipt['nativePlanSha256'], 'nativeResultSha256': receipt['nativeResultSha256'],
              'localCheckPlanSha256': sha(output / 'local-check-plan.json'),
              'derivedPlanChangedKeys': ['source', 'output'], 'facts': facts,
              'artifact': str(output / 'artifact'), 'localNodeSha256': sha(args.node)}
    write_json(output / 'verification.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='mode', required=True)
    native = commands.add_parser('pack')
    for name in ['plan', 'plan-sha256', 'result', 'result-sha256', 'checker', 'out']:
        native.add_argument('--' + name, required=True)
    local = commands.add_parser('verify')
    for name in ['archive', 'archive-sha256', 'transport', 'transport-sha256', 'source', 'checker', 'node', 'out']:
        local.add_argument('--' + name, required=True)
    args = parser.parse_args()
    print(json.dumps(pack(args) if args.mode == 'pack' else verify(args), indent=2))


if __name__ == '__main__':
    main()
