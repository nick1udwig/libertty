import ast, json, sys

try:
    tree = ast.parse(open(sys.argv[1], encoding='utf-8').read())
    parsers = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
            if getattr(node.value.func, 'attr', getattr(node.value.func, 'id', '')) == 'ArgumentParser':
                parsers.update(target.id for target in node.targets if isinstance(target, ast.Name))
    flags = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or getattr(node.func, 'attr', '') != 'add_argument':
            continue
        if getattr(node.func.value, 'id', '') not in parsers:
            continue
        options = {keyword.arg: keyword.value.value for keyword in node.keywords if isinstance(keyword.value, ast.Constant)}
        takes = options.get('action', '') not in ('store_true', 'store_false', 'count', 'help', 'version') and options.get('nargs') != 0
        schema = None
        if takes:
            nargs = options.get('nargs', 1)
            minimum = nargs if isinstance(nargs, int) else (0 if nargs in ('?', '*') else 1)
            maximum = nargs if isinstance(nargs, int) else (1 if nargs == '?' else None)
            if not 0 <= minimum <= 64 or maximum is not None and not 0 <= maximum <= 64:
                continue
            values = []
            kind = 'text'
            for keyword in node.keywords:
                if keyword.arg == 'type' and getattr(keyword.value, 'id', getattr(keyword.value, 'attr', '')) == 'Path':
                    kind = 'path'
                if keyword.arg == 'choices' and isinstance(keyword.value, (ast.List, ast.Tuple)):
                    if all(isinstance(value, ast.Constant) and isinstance(value.value, (str, int, float)) for value in keyword.value.elts):
                        values = [str(value.value) for value in keyword.value.elts][:256]
                        kind = 'choice'
            metavar = str(options.get('metavar', '')).lower()
            if metavar in ('file', 'filename', 'path'):
                kind = 'path'
            elif metavar in ('dir', 'directory'):
                kind = 'directory'
            if nargs != 1 or kind != 'text':
                schema = {'minimum': minimum, 'kind': kind}
                if maximum is not None:
                    schema['maximum'] = maximum
                if values:
                    schema['choices'] = values
        for argument in node.args:
            if isinstance(argument, ast.Constant) and isinstance(argument.value, str) and argument.value.startswith('-'):
                flag = {'name': argument.value, 'takesValue': takes}
                if schema is not None:
                    flag['value'] = schema
                flags.append(flag)
    print(json.dumps(flags if parsers else None))
except (SyntaxError, UnicodeError, OSError):
    print('null')
