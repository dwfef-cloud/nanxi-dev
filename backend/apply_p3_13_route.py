# -*- coding: utf-8 -*-
"""P3-13: compliance route maps RuntimeError -> 409. Also add HTTPException import."""
p = r"D:\nanxi-dev\backend\app\api\routes\compliance.py"
d = open(p, "rb").read()

# 1) ensure HTTPException is imported
if b"HTTPException" not in d:
    old_imp = b"from fastapi import APIRouter, Depends\n"
    new_imp = b"from fastapi import APIRouter, Depends, HTTPException\n"
    assert old_imp in d, "import anchor not found"
    d = d.replace(old_imp, new_imp, 1)

# 2) wrap resume_all call
old_call = (
    b'def resume_all(\n'
    b'    service: ComplianceService = Depends(get_compliance_service),\n'
    b') -> dict:\n'
)
assert old_call in d, "resume route anchor not found"

# Replace the body: find the docstring line then the return line
idx = d.find(old_call)
after = d[idx + len(old_call):]
# after starts with the docstring line(s). Find the return line.
ret_pos = after.find(b'    return service.resume_all()\n')
assert ret_pos >= 0, "return line not found"
new_call = old_call + after[:ret_pos] + (
    b'    try:\n'
    b'        return service.resume_all()\n'
    b'    except RuntimeError as exc:\n'
    b'        # P3-13: safe mode active -> 409 Conflict\n'
    b'        raise HTTPException(status_code=409, detail=str(exc)) from exc\n'
)
# skip past the old return line
consumed = ret_pos + len(b'    return service.resume_all()\n')
d = d[:idx] + new_call + after[consumed:]

open(p, "wb").write(d)
print("P3-13 route done")
