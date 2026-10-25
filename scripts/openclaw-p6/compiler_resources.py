"""Sample owned compiler descendants and existing cgroups without changing them."""
import datetime
import json
import os
from pathlib import Path
import threading
import time


class CompilerResources:
    def __init__(self, path, pid):
        self.path = path
        self.pid = pid
        self.done = threading.Event()
        self.errors = []
        self.count = 0
        self.peak_rss_kib = 0
        self.thread = threading.Thread(target=self.run, name='compiler-resources')
        self.cgroups = self.resolve_cgroups()

    def resolve_cgroups(self):
        # Existing cgroups may be shared and their peaks may predate this build.
        groups = []
        membership = Path(f'/proc/{self.pid}/cgroup').read_text()
        for line in Path('/proc/self/mountinfo').read_text().splitlines():
            before, after = line.split(' - ', 1)
            mount = before.split()
            kind, _, options = after.split()[:3]
            for entry in membership.splitlines():
                _, controllers, suffix = entry.split(':', 2)
                if kind == 'cgroup2' and not controllers or kind == 'cgroup' and 'memory' in controllers.split(',') and 'memory' in options.split(','):
                    base = mount[3]
                    if base != '/' and suffix != base and not suffix.startswith(base.rstrip('/') + '/'):
                        continue
                    relative = suffix[len(base):] if base != '/' else suffix
                    path = Path(mount[4]) / relative.lstrip('/')
                    groups.append({'kind': kind, 'path': str(path), 'mountRoot': base, 'membership': entry})
        return groups

    def sample(self):
        procs = {}
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                stat = (path / 'stat').read_text().rsplit(')', 1)[1].split()
                procs[int(path.name)] = (int(stat[1]), int(stat[2]), int(stat[19]))
            except (FileNotFoundError, ProcessLookupError):
                continue
        owned = {self.pid}
        while True:
            added = {pid for pid, (parent, group, _) in procs.items() if parent in owned or group == self.pid}
            if added <= owned:
                break
            owned.update(added)
        rows = []
        for pid in sorted(owned & procs.keys()):
            try:
                raw = Path(f'/proc/{pid}/status').read_text()
                fields = {key: value.strip() for key, value in (line.split(':', 1) for line in raw.splitlines())}
                selected = {key: fields.get(key) for key in ['Name', 'State', 'PPid', 'VmRSS', 'VmHWM', 'Threads']}
                rows.append({'pid': pid, 'startTimeTicks': procs[pid][2], 'pgrp': procs[pid][1], 'status': selected})
            except (FileNotFoundError, ProcessLookupError):
                continue
        rss = sum(int(row['status']['VmRSS'].split()[0]) for row in rows if row['status']['VmRSS'])
        self.peak_rss_kib = max(self.peak_rss_kib, rss)
        cgroups = []
        for group in self.cgroups:
            names = ['memory.current', 'memory.peak', 'memory.max', 'memory.swap.current', 'memory.swap.peak', 'memory.swap.max', 'memory.events', 'memory.events.local'] if group['kind'] == 'cgroup2' else ['memory.usage_in_bytes', 'memory.max_usage_in_bytes', 'memory.limit_in_bytes', 'memory.memsw.usage_in_bytes', 'memory.memsw.max_usage_in_bytes', 'memory.failcnt', 'memory.oom_control']
            values = {}
            for name in names:
                try:
                    values[name] = (Path(group['path']) / name).read_text()
                except FileNotFoundError:
                    values[name] = None
            cgroups.append({**group, 'raw': values, 'scope': 'existing cgroup; not isolated or reset by this monitor'})
        row = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'monotonic': time.monotonic(), 'rootPid': self.pid, 'processes': rows, 'sampledAggregateRssKiB': rss, 'rssScope': 'sampled descendant/process-group RSS sum; shared pages counted more than once, short-lived processes may be missed', 'cgroups': cgroups, 'meminfo': Path('/proc/meminfo').read_text(), 'vmstat': '\n'.join(line for line in Path('/proc/vmstat').read_text().splitlines() if line.startswith(('oom_kill ', 'pswpin ', 'pswpout '))) + '\n'}
        self.count += 1
        return row

    def run(self):
        try:
            with self.path.open('x') as output:
                while True:
                    output.write(json.dumps(self.sample(), separators=(',', ':')) + '\n')
                    output.flush()
                    if self.done.wait(1):
                        output.write(json.dumps(self.sample(), separators=(',', ':')) + '\n')
                        output.flush()
                        break
        except Exception as error:
            self.errors.append(f'{type(error).__name__}: {error}')

    def start(self):
        self.thread.start()

    def finish(self):
        self.done.set()
        self.thread.join()
        return {'intervalSeconds': 1, 'samples': self.count, 'maximumSampledAggregateRssKiB': self.peak_rss_kib, 'errors': self.errors, 'rawPath': str(self.path), 'cgroupScope': 'existing cgroups; historical/shared peak is not a task peak', 'memoryFitQualified': False}
