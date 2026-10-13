#!/usr/bin/env python3
import json, os, select, sys, time

def record(event, **values):
    with open(os.environ['TEST_TERMINAL_LOG'], 'a') as output:
        output.write(json.dumps(dict(event=event, pid=os.getpid(), **values)) + '\n')

arguments = sys.argv[1:]
record('open', arguments=arguments)
if os.environ.get('TEST_TERMINAL_FAIL'):
    sys.exit(1)
width = int(arguments[arguments.index('--cols') + 1]) if '--cols' in arguments else 80
height = int(arguments[arguments.index('--rows') + 1]) if '--rows' in arguments else 24
def frame(full=True, data='YWJj'):
    print(json.dumps(dict(type='terminal.frame', encoding='ansi', width=width, height=height, full=full, bytes=data)), flush=True)

frame()
previous = ''
pending = b''
try:
    while True:
        try:
            with open(os.environ['TEST_TERMINAL_FRAME']) as source:
                current = source.read()
            if current and current != previous:
                previous = current
                print(current, flush=True)
        except FileNotFoundError:
            pass
        if not select.select([sys.stdin], [], [], .01)[0]:
            continue
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            if arguments[2] == 'observe' and os.environ.get('TEST_TERMINAL_OBSERVER_IGNORES_STDIN'):
                time.sleep(.01)
                continue
            break
        pending += chunk
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            message = json.loads(line)
            record('command', message=message)
            if message['type'] == 'terminal.resize':
                width, height = message['cols'], message['rows']
                frame()
finally:
    record('close')
