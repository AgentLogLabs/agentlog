path = "/home/hobo/.npm-global/lib/node_modules/openclaw/dist/reply-Bm8VrLQh.js"
content = open(path, encoding="utf-8").read()

old = 'return modelLabel === defaultLabel ? `\u2705 New session started \u00b7 model: ${modelLabel}` : `\u2705 New session started \u00b7 model: ${modelLabel} (default: ${defaultLabel})`;'

new_code = 'const _agentlogTraceId = process.env.AGENTLOG_TRACE_ID;\n\tconst _agentlogTraceSuffix = _agentlogTraceId ? ` \u00b7 trace: ${_agentlogTraceId}` : "";\n\treturn modelLabel === defaultLabel ? `\u2705 New trace started \u00b7 model: ${modelLabel}${_agentlogTraceSuffix}` : `\u2705 New trace started \u00b7 model: ${modelLabel} (default: ${defaultLabel})${_agentlogTraceSuffix}`;'

if old in content:
    content = content.replace(old, new_code, 1)
    open(path, "w", encoding="utf-8").write(content)
    print("patched ok")
    idx = content.find("New trace started")
    print(repr(content[max(0,idx-50):idx+300]))
else:
    print("ERROR: pattern not found")
    idx = content.find("New session started")
    print(repr(content[max(0,idx-50):idx+200]))
