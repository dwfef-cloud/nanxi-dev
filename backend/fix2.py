path = r'C:\Users\天选Air\.codex\worktrees\3a35\获客系统开发\app\repositories\sqlite.py'
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Check line 275 context
print('=== Line 270-280 ===')
for i in range(269, 280):
    print(f'{i+1}: {lines[i].rstrip()[:90]}')

# Fix line 876 (index 875): 19 question marks -> 18
old19 = 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
new18 = 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
lines[875] = lines[875].replace(old19, new18)
qcount = lines[875].count('?')
print(f'Fixed line 876: {qcount} question marks')

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(lines)
print('Saved')
