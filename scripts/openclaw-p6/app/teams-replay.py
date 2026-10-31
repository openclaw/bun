#!/usr/bin/env python3
"""Restore one exact exported app artifact for untimed Teams proof, without a build."""
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from selection import requested_variants

HERE = Path(__file__).resolve().parent
ROOT = Path('/home/runner/.cache/oc-ty-ext/P6/app-x64-final-r4-v1')
CUT = '4fa442e332745f1f58ccedd27106abdafcf4e019'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def compiler_binding(plan, records, pins):
    profile = plan['compiler']['profile']
    assert profile == ('cb-compat' if plan['variant'] == 'c2' else 'cb-standard')
    record = records[profile]
    assert records['status'] == 'native-compilers-adopted-not-app-admitted'
    for key in ['sha256', 'cohort', 'bunCommit', 'webkitCommit', 'engineFeatures']:
        assert record[key] == plan['compiler'][key], 'Originating compiler record differs: ' + key
    assert record['sha256'] == pins['artifacts'][profile]['compilerSha256']
    assert record['cohort'] == 'rd-p6-150c'
    assert record['bunCommit'] == '150c9620c53710060186b8b0cd50985e035408b0'
    assert record['webkitCommit'] == 'aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8'
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', type=Path, required=True)
    parser.add_argument('--variant', choices=['js', 'c2-off', 'ts'], required=True)
    parser.add_argument('--helper-head', required=True)
    args = parser.parse_args()
    assert platform.system() == 'Linux' and platform.machine() == 'x86_64'
    assert sys.version_info >= (3, 12)
    os.umask(0o077)
    # Run from a clean, reviewed helper checkout; the download pins bind the original app head separately.
    def git(directory, *arguments):
        return subprocess.check_output(['git', '-C', str(directory), *arguments], text=True).strip()
    assert git(HERE, 'rev-parse', 'HEAD') == args.helper_head
    assert not git(HERE, 'status', '--porcelain', '--untracked-files=no')
    contract = module('p6_app_transport', HERE / 'benchmark/app_contract.py')
    load, sha = contract.load, contract.sha
    for name, digest in load(ROOT / 'manifest.json')['files'].items():
        assert sha(ROOT / name) == digest, 'Staged helper changed: ' + name
    source = ROOT / 'source'
    source_proof = load(ROOT / 'admission-inputs/source-preparation.json')
    assert git(source, 'rev-parse', 'HEAD') == CUT
    assert git(source, 'rev-parse', 'HEAD^{tree}') == source_proof['sourceTree']
    assert not git(source, 'status', '--porcelain', '--untracked-files=no')
    download = args.download.resolve(strict=True)
    assert not download.is_relative_to(ROOT) and not ROOT.is_relative_to(download), 'Keep the original export outside the replay root'
    imported = download / 'export'
    verified = contract.verify_export(load(download / 'pins.json'), load(download / 'run.json'),
        load(download / 'artifact.json'), download / 'app.zip', imported, existing=True)
    assert load(download / 'verification.json') == verified
    original_execution = load(imported / 'host/execution.json')
    assert args.variant in requested_variants(original_execution)
    work = Path(os.environ['P6_WORK']).resolve(strict=True)
    assert not work.is_relative_to(download) and not download.is_relative_to(work), 'Replay workspace overlaps original export'
    replay_execution = {'kind':'untimed-functional-replay', 'sourceCommit':CUT,
        'originatingAppExport':verified, 'variantSelection':original_execution['variantSelection'],
        'requestedVariants':original_execution['requestedVariants'], 'helperHead':args.helper_head,
        'performanceEligible':False}
    execution_path = work / 'execution.json'
    if execution_path.exists():
        assert load(execution_path) == replay_execution, 'Replay origin differs from this workspace'
    else:
        contract.dump(execution_path, replay_execution)
    entry = contract.classify(imported, args.variant)
    assert entry['status'] == 'available-pending-native-restoration', entry
    paths = {key: Path(value) for key, value in entry['paths'].items()}
    build, plan = load(paths['build']), load(paths['plan'])
    compiler = compiler_binding(plan, load(imported / 'admission-inputs/compiler-records.json'), load(HERE / 'compiler-pins.json'))
    node = ROOT / 'opt/node/bin/node'
    assert str(node) == plan['buildNode']['path'] and sha(node) == plan['buildNode']['sha256']
    assert subprocess.check_output([str(node), '--version'], env={'PATH':'/usr/bin:/bin'}, text=True).strip() == 'v26.12.1'
    transport = load(paths['transport'])
    assert transport['nativePlanSha256'] == sha(paths['plan'])
    assert transport['nativeResultSha256'] == sha(paths['build'])
    artifact = ROOT / 'artifacts' / args.variant
    assert plan['source'] == str(source) and plan['output'] == str(artifact)
    output = ROOT / 'teams-replay' / args.variant
    preserve = module('p6_preserved_artifact', ROOT / 'preserve.py')
    restoration = preserve.verify(argparse.Namespace(archive=paths['archive'],
        archive_sha256=transport['archiveSha256'], transport=paths['transport'],
        transport_sha256=sha(paths['transport']), source=source,
        checker=ROOT / 'build-prep/artifact-contract.mjs', node=node, out=output))
    assert not artifact.exists()
    artifact.parent.mkdir(exist_ok=True)
    (output / 'artifact').rename(artifact)
    for key, relative in [('admission', f'admissions/{args.variant}.json'),
                          ('plan', f'build-receipts/{args.variant}/plan.json'),
                          ('build', f'build-receipts/{args.variant}/result.json')]:
        target = ROOT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        assert not target.exists()
        shutil.copyfile(paths[key], target)
    receipt = {'status':'restored-for-teams-not-runtime-qualified', 'sourceCommit':CUT,
        'sourceTree':source_proof['sourceTree'], 'helperHead':args.helper_head,
        'stagedPayloadSha256':sha(ROOT / 'manifest.json'), 'originatingAppExport':verified,
        'variant':args.variant, 'originalBuildReceiptSha256':sha(paths['build']),
        'compiler':compiler, 'originatingCompilerRecordsSha256':sha(imported / 'admission-inputs/compiler-records.json'),
        'compilerExecuted':False, 'nodeSha256':sha(node),
        'restoration':restoration, 'restorationReceiptSha256':sha(output / 'verification.json'),
        'preparedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'runtimeExecuted':False, 'buildExecuted':False, 'performanceEligible':False}
    contract.dump(output / 'replay-binding.json', receipt)
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
