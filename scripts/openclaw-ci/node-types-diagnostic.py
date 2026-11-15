"""Compare fixture boundaries using the admitted native compiler, without rebuilding it."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


root = Path.cwd()
binary = root / "build/release/bun"
output = root / "build/openclaw-ci/trim-diagnostics"
output.mkdir(parents=True, exist_ok=True)
fixture = Path("test/aot/types-of-node-classes-name-what-buns-modules-make.test.ts")
current = (root / fixture).read_text()
original = (root / "node-types-baseline" / fixture).read_text()


def template(source, name):
    matches = re.findall(r"const " + name + r" = `([^`]+)`;", source)
    assert len(matches) == 1 and "${" not in matches[0], "fixture template changed"
    return matches[0]


program = template(current, "program")
exercise = template(current, "exercise")
old_program = template(original, "program")
assert program.count('res.end("hello");') == 1, "response fixture changed"
streamed_program = program.replace('res.end("hello");',
    'for (let index = 0; index < 5; index++) res.write("hello"[index]);\n  res.end();')
env = {**os.environ, "BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING": "1",
       "BUN_GARBAGE_COLLECTOR_LEVEL": "1", "BUN_JSC_randomIntegrityAuditRate": "1.0",
       "BUN_ENABLE_CRASH_REPORTING": "0", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
       "BUN_DEBUG_QUIET_LOGS": "1", "GITHUB_ACTIONS": "false", "CI": "1",
       "NO_COLOR": "1", "TZ": "Etc/UTC"}
for name in ("NODE_OPTIONS", "BUN_OPTIONS", "BUN_BE_BUN", "JSC_useJIT", "FORCE_COLOR"):
    env.pop(name, None)
expected = "true false 2 4\n200 text/plain hello\n404 text/plain hello\n"
summary = {"complete": False, "nativeSource": os.environ["EXPECTED_NATIVE_SHA"],
           "probeSource": os.environ["GITHUB_SHA"], "variants": []}
summary_path = output / "node-types.json"


def run(command, cwd):
    try:
        result = subprocess.run(command, cwd=cwd, env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    except subprocess.TimeoutExpired as error:
        text = lambda value: value.decode(errors="replace") if isinstance(value, bytes) else value or ""
        return {"stdout": text(error.stdout), "stderr": text(error.stderr), "exitCode": None, "timedOut": True}
    return {"stdout": result.stdout, "stderr": result.stderr, "exitCode": result.returncode}


for label, source, dependency, strict in [
    ("split", program, exercise, False),
    ("split-strict-dependency", program, exercise, True),
    ("original-single-file", old_program, None, False),
    ("split-streamed-response", streamed_program, exercise, False),
]:
    with tempfile.TemporaryDirectory(prefix="node-types-") as temporary:
        folder = Path(temporary)
        (folder / "main.ts").write_text(source)
        types = folder / "node_modules/@types"
        types.mkdir(parents=True)
        (types / "bun").symlink_to(root / "packages/bun-types", target_is_directory=True)
        if dependency is not None:
            package = folder / "node_modules/exercise"
            package.mkdir(parents=True)
            (package / "package.json").write_text(json.dumps(
                {"name": "exercise", "type": "module", "main": "index.ts"}))
            (package / "index.ts").write_text(dependency)
            if strict:
                (package / "tsconfig.json").write_text(json.dumps({"compilerOptions": {"strict": True}}))
        executable = folder / "app"
        build = run([str(binary), "build", "--compile", "--aot", "--explain=json",
                     "main.ts", "--outfile", str(executable)], folder)
        (output / (label + ".log")).write_text(json.dumps({"build": build}, indent=2))
        assert build["exitCode"] == 0, label + " failed to compile"
        reports = [json.loads(line) for line in build["stdout"].splitlines() if line.startswith("{")]
        assert reports and "accesses" in reports[0], label + " has no explain summary"
        causes = reports[1:]
        assert reports[0]["causes"] == len(causes), label + " explain causes are incomplete"
        assert [cause["rank"] for cause in causes] == list(range(1, len(causes) + 1)), label + " explain ranks changed"
        first_line = 6 if dependency is None else 5
        positions = {(first_line, 3), (first_line, 20), (first_line, 44), (first_line + 1, 3), (first_line + 2, 3)}
        answer = [cause for cause in causes if cause.get("function") == "answer"
                  and Path(cause.get("file", "")).name == "main.ts"
                  and (cause.get("line"), cause.get("column")) in positions]
        plain = run([str(binary), "main.ts"], folder)
        compiled = run([str(executable)], folder)
        row = {"variant": label, "sourceSHA256": hashlib.sha256(source.encode()).hexdigest(),
               "reports": reports, "answerCauses": answer, "plain": plain, "compiled": compiled}
        summary["variants"].append(row)
        summary_path.write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps({"variant": label, "accesses": reports[0]["accesses"],
                          "plainExit": plain["exitCode"], "compiledExit": compiled["exitCode"]}), flush=True)

assert summary["variants"][0]["reports"][0]["accesses"]["byName"] == 5, "original failure did not reproduce"
summary["complete"] = True
summary_path.write_text(json.dumps(summary, indent=2) + "\n")
for row in summary["variants"]:
    assert row["plain"]["stdout"] == expected and row["plain"]["exitCode"] == 0, row["variant"] + " interpreter behavior changed"
    assert row["compiled"] == row["plain"], row["variant"] + " compiled behavior differs"
