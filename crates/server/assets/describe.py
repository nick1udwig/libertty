import ast,json,sys
try:
 tree=ast.parse(open(sys.argv[1],encoding='utf-8').read())
 flags=[]
 for node in ast.walk(tree):
  if not isinstance(node,ast.Call): continue
  name=getattr(node.func,'attr','')
  if name not in ('add_argument','option'): continue
  options={k.arg:k.value.value for k in node.keywords if isinstance(k.value,ast.Constant)}
  takes=options.get('action','') not in ('store_true','store_false','count','help','version') and options.get('is_flag') != True and options.get('nargs') != 0
  for arg in node.args:
   if isinstance(arg,ast.Constant) and isinstance(arg.value,str) and arg.value.startswith('-'):
    flags.append({'name':arg.value,'takesValue':takes})
 print(json.dumps(flags))
except (SyntaxError,UnicodeError,OSError): print('[]')
