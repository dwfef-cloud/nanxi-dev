# -*- coding: utf-8 -*-
"""Apply P3-10 / P3-8 / P3-13 code edits via exact line replacement.
All target files are CRLF. We build CRLF byte strings from line lists."""

CRLF = b"\r\n"

def read(p):
    with open(p, "rb") as f:
        return f.read()

def write(p, d):
    with open(p, "wb") as f:
        f.write(d)

def enc(lines):
    """Join list of str (or bytes) with CRLF, return bytes."""
    out = []
    for ln in lines:
        if isinstance(ln, str):
            out.append(ln.encode("utf-8"))
        else:
            out.append(ln)
    return CRLF.join(out)

# ── P3-10: explicit min<=max validation in dm_sender_service.update_config ──
p = r"D:\nanxi-dev\backend\app\services\dm_sender_service.py"
d = read(p)
old = enc([
    '        if min_interval is not None:',
    '            cfg["min_interval"] = max(0, int(min_interval))',
    '        if max_interval is not None:',
    '            cfg["max_interval"] = max(cfg["min_interval"], int(max_interval))',
    '        if daily_limit is not None:',
])
new = enc([
    '        if min_interval is not None:',
    '            cfg["min_interval"] = max(0, int(min_interval))',
    '        if max_interval is not None:',
    '            cfg["max_interval"] = max(0, int(max_interval))',
    '        # P3-10: explicitly reject min_interval > max_interval (was silently normalized)',
    '        if cfg["min_interval"] > cfg["max_interval"]:',
    '            raise ValueError(',
    '                "min_interval(%d) must be <= max_interval(%d)"',
    '                % (cfg["min_interval"], cfg["max_interval"]),',
    '            )',
    '        if daily_limit is not None:',
])
assert old in d, "P3-10 old not found"
d = d.replace(old, new, 1)
write(p, d)
print("P3-10 done")

# ── P3-8: clarifying comment in dm_sender_service.get_config ──
p = r"D:\nanxi-dev\backend\app\services\dm_sender_service.py"
d = read(p)
old = enc([
    '    def get_config(self) -> dict:',
    '        s = self._repo.get_system_settings(_CONFIG_CATEGORY)',
    '        return {',
])
new = enc([
    '    def get_config(self) -> dict:',
    '        # P3-8: daily_limit here is a SENDER-SIDE conservative cap (default 50).',
    '        # It is intentionally DIFFERENT from per-account Account.daily_limit (default 80,',
    '        # auto-reduced to 40 on R1 throttling). The two guards are complementary:',
    '        #   Account.daily_limit = account own daily outreach quota (risk engine)',
    '        #   dm_sender.daily_limit = sender-side soft cap when picking accounts',
    '        # Both are tunable together: account model + dm_sender config.',
    '        s = self._repo.get_system_settings(_CONFIG_CATEGORY)',
    '        return {',
])
assert old in d, "P3-8 dm old not found"
d = d.replace(old, new, 1)
write(p, d)
print("P3-8 done (dm_sender comment)")

# ── P3-8: clarifying comment in domain.py Account.daily_limit ──
p = r"D:\nanxi-dev\backend\app\models\domain.py"
d = read(p)
old = b'    daily_limit: int = 80'
idx = d.find(old)
assert idx >= 0, "P3-8 domain anchor not found"
# find end of that line
eol = d.find(b'\n', idx)
new_lines = enc([
    '    # P3-8: per-account daily outreach quota (risk engine). Healthy=80, R1 throttled=40.',
    '    # This is the ACCOUNT-level limit enforced by scheduler; dm_sender has a separate',
    '    # sender-side cap (default 50) - see DmSenderService.get_config.',
    '    daily_limit: int = 80',
])
d = d[:idx] + new_lines + d[eol:]
write(p, d)
print("P3-8 done (domain comment)")

# ── P3-13: resume_all raises RuntimeError when safe mode active ──
p = r"D:\nanxi-dev\backend\app\services\compliance_service.py"
d = read(p)
anchor = enc([
    '        state = self._repo.get_runtime()',
    '        if state.safe_mode_active:',
])
idx = d.find(anchor)
assert idx >= 0, "P3-13 anchor not found"
# find the two lines of the old return block (anchor line + return line)
line2_end = d.find(b'\n', idx + len(anchor)) + 1
# the return statement is on the line right after the anchor's second line
ret_start = line2_end
ret_end = d.find(b'\n', ret_start) + 1
new_block = enc([
    '        state = self._repo.get_runtime()',
    '        if state.safe_mode_active:',
    '            # P3-13: raise so the route maps it to HTTP 409 Conflict',
    '            raise RuntimeError("safe_mode_active: please exit safe mode before resuming")',
])
d = d[:idx] + new_block.encode("utf-8") + d[ret_end:] if False else d[:idx] + new_block + d[ret_end:]
write(p, d)
print("P3-13 done (service)")

print("ALL SERVICE EDITS COMPLETE")
