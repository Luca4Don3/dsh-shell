"""Run an isolated shell fixture under a real POSIX controlling terminal."""
import errno
import json
import os
import pty
import select
import signal
import sys
import time

spec = json.load(sys.stdin)
pid, master = pty.fork()
if pid == 0:
    os.chdir(spec['cwd'])
    os.execve(spec['argv'][0], spec['argv'], spec['env'])

output = bytearray()
status = None
timed_out = False
try:
    os.write(master, spec['input'].encode())
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                output.extend(chunk)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
        if status is None:
            exited, outcome = os.waitpid(pid, os.WNOHANG)
            if exited:
                status = outcome
    else:
        timed_out = True
finally:
    if status is None:
        exited, outcome = os.waitpid(pid, os.WNOHANG)
        if not exited:
            os.kill(pid, signal.SIGKILL)
            _, outcome = os.waitpid(pid, 0)
        status = outcome
    os.close(master)

print(json.dumps({'stdout': output.decode(errors='replace'), 'stderr': '',
                 'timedOut': timed_out, 'status': os.waitstatus_to_exitcode(status)}))
