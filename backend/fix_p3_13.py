# -*- coding: utf-8 -*-
"""Fix P3-13: revert enter_safe_mode mistake, apply raise to resume_all only."""
p = r"D:\nanxi-dev\backend\app\services\compliance_service.py"
d = open(p, "rb").read()

# 1) Revert the wrong change in enter_safe_mode
wrong = (
    b'        state = self._repo.get_runtime()\n'
    b'        if state.safe_mode_active:\n'
    b'            # P3-13: raise so the route maps it to HTTP 409 Conflict\n'
    b'            raise RuntimeError("safe_mode_active: please exit safe mode before resuming")\n'
)
right_enter = (
    b'        state = self._repo.get_runtime()\n'
    b'        if state.safe_mode_active:\n'
    b'            return {"ok": True, "message": "\xe5\xae\x89\xe5\x85\xa8\xe6\xa8\xa1\xe5\xbc\x8f\xe5\xb7\xb2\xe5\xa4\x84\xe4\xba\x8e\xe6\xbf\x80\xe6\xb4\xbb\xe7\x8a\xb6\xe6\x80\x81", "alreadyActive": True}\n'
)
assert wrong in d, "wrong block not found in enter_safe_mode"
d = d.replace(wrong, right_enter, 1)

# 2) Apply raise to resume_all (the SECOND occurrence pattern: ok:False return)
old_resume = (
    b'        state = self._repo.get_runtime()\n'
    b'        if state.safe_mode_active:\n'
    b'            return {"ok": False, "message": "\xe5\xae\x89\xe5\x85\xa8\xe6\xa8\xa1\xe5\xbc\x8f\xe6\xbf\x80\xe6\xb4\xbb\xe4\xb8\xad\xef\xbc\x8c\xe8\xaf\xb7\xe5\x85\x88\xe9\x80\x80\xe5\x87\xba\xe5\xae\x89\xe5\x85\xa8\xe6\xa8\xa1\xe5\xbc\x8f\xe5\x86\x8d\xe6\x81\xa2\xe5\xa4\x8d\xe4\xbb\xbb\xe5\x8a\xa1", "safeMode": True}\n'
)
new_resume = (
    b'        state = self._repo.get_runtime()\n'
    b'        if state.safe_mode_active:\n'
    b'            # P3-13: raise so the route maps it to HTTP 409 Conflict\n'
    b'            raise RuntimeError("safe_mode_active: please exit safe mode before resuming")\n'
)
assert old_resume in d, "resume_all old block not found"
d = d.replace(old_resume, new_resume, 1)

open(p, "wb").write(d)
print("P3-13 corrected")
