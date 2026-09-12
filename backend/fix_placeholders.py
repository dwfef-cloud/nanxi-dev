import re
path = r'C:\Users\天选Air\.codex\worktrees\3a35\获客系统开发\app\repositories\sqlite.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find all VALUES (???) patterns and their question mark counts
matches = list(re.finditer(r'VALUES \(\?+\)', content))
for i, m in enumerate(matches):
    qcount = m.group().count('?')
    # Get surrounding context
    start = max(0, m.start() - 200)
    context = content[start:m.end()]
    if 'crawl' in context.lower() or qcount == 19:
        print(f"Match {i}: {qcount} question marks")
        print(f"  Context: ...{context[-100:]}")
        if qcount == 19:
            # Fix it
            old = m.group()
            new = 'VALUES (' + '?' * 18 + ')'
            content = content[:m.start()] + new + content[m.end():]
            print(f"  FIXED to 18 question marks")

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print("Done")
