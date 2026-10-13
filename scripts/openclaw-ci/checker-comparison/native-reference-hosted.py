import json
import os
from pathlib import Path
import subprocess
import sys
import hosted

source, output = [Path(arg).resolve(strict=True) for arg in sys.argv[1:]]
status = {"phase": "native-reference-diagnostic", "source": hosted.SOURCE, "manifestSha256": hosted.MANIFEST, "runExitCode": None, "sourceVerified": False}
code = 1
try:
    hosted.require(str(output).startswith("/work/crabbox/") and not output.is_relative_to(source), "output must be separate task-owned work root")
    hosted.require(subprocess.check_output(["stat", "-f", "-c", "%T", str(output)], text=True).strip() != "tmpfs", "output is tmpfs")
    manifest, env, dependency = hosted.prepare_dependencies(source, output)
    env.pop("GITHUB_ACTIONS", None)
    status["runExitCode"] = subprocess.run([
        "timeout", "--signal=TERM", "--kill-after=5s", "660s",
        str(output / "runtime/node-v24.16.0-linux-x64/bin/node"),
        str(Path(__file__).with_name("native-reference-diagnostic.mjs")),
        str(source), str(output),
    ], cwd=source, env=env).returncode
    hosted.verify(source, source / hosted.PREFIX, True)
    status["sourceVerified"] = True
    receipt = output / "native-reference.json"
    if receipt.exists():
        value = json.loads(receipt.read_bytes())
        hosted.require(value["source"] == hosted.SOURCE and value["manifestSha256"] == hosted.MANIFEST, "diagnostic identity differs")
        value.update(sourceVerified=True, dependencyReceipt=dependency)
        temporary = receipt.with_suffix(".json.part")
        temporary.write_text(json.dumps(value, indent=2) + "\n")
        temporary.replace(receipt)
    else:
        raise RuntimeError("Native reference diagnostic receipt missing")
    code = status["runExitCode"]
except Exception as error:
    status["adapterFailure"] = str(error)
finally:
    status["adapterExitCode"] = code
    status["hostedContext"] = {key: os.environ.get(key) for key in ("GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "GITHUB_SHA")}
    (output / "run-status.json").write_text(json.dumps(status) + "\n")
raise SystemExit(code)
