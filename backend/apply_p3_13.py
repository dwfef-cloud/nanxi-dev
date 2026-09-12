# -*- coding: utf-8 -*-
"""P3-13 fix for compliance_service.py (LF line endings)."""
p = r"D:\nanxi-dev\backend\app\services\compliance_service.py"
d = open(p, "rb").read()

anchor = (
    b'        state = self._repo.get_runtime()\n'
    b'        if state.safe_mode_active:\n'
)
idx = d.find(anchor)
assert idx >= 0, "anchor not found"

# old block = anchor + the return line (which spans one physical line here)
ret_start = idx + len(anchor)
ret_end = d.find(b'\n', ret_start) + 1  # end of the return line

new_block = (
    b'        state = self._repo.get_runtime()\n'
    b'        if state.safe_mode_active:\n'
    b'            # P3-13: raise so the route maps it to HTTP 409 Conflict\n'
    b'            raise RuntimeError("safe_mode_active: please exit safe mode before resuming")\n'
)
d = d[:idx] + new_block + d[ret_end:]
open(p, "wb").write(d)
print("P3-13 service done")
