"""Preserve original per-profile run evidence, including failed builds; no upload."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--profile', choices=['cb-standard','cb-compat'], required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    assert root == Path.home()/'.cache/oc-ty-ext/P6/rd150c-x64-highmem-deadline-v1'
    files = sorted(p for p in (root/'receipts').glob(args.profile+'*') if p.is_file() and not p.is_symlink())
    assert files, 'No run evidence exists'
    files.append(root/'source-ready.json')
    target = root/('raw-'+args.profile)
    target.mkdir(exist_ok=False)
    with tarfile.open(target/'evidence.tar', 'w') as archive:
        for path in files:
            archive.add(path, arcname=str(path.relative_to(root)), recursive=False)
    receipt = {'profile': args.profile, 'archive': str(target/'evidence.tar'), 'sha256': sha(target/'evidence.tar'), 'bytes': (target/'evidence.tar').stat().st_size, 'files': {str(path.relative_to(root)): sha(path) for path in files}, 'scope': 'original raw run evidence; may describe a failed or interrupted experiment', 'memoryFitQualified': False}
    (target/'transport.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
