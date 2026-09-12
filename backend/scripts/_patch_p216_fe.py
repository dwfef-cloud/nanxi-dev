# -*- coding: utf-8 -*-
"""P2-16 frontend: add 'new followup' button + modal on followups page."""
import io, os

ROOT = r"D:\nanxi-dev\frontend"

def patch(relpath, old, new, count=1):
    p = os.path.join(ROOT, relpath)
    s = io.open(p, encoding="utf-8").read()
    found = s.count(old)
    assert found == count, f"{relpath}: expected {count}, got {found}: {old[:70]!r}"
    s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8").write(s)
    print("OK", relpath)

# 1) pageHead 加新建按钮
patch(
    r"assets\js\app.js",
    '''        ${pageHead({ icon: 'calendar', title: '今日跟进', desc: '高客单线索跟丢无感知的解药 · SOP 自动生成 + 逾期红色提醒' })}''',
    '''        ${pageHead({ icon: 'calendar', title: '今日跟进', desc: '高客单线索跟丢无感知的解药 · SOP 自动生成 + 逾期红色提醒',
          actions: '<button type="button" class="btn btn--primary btn--sm" id="btn-new-fu">+ 新建跟进</button>' })}''',
)

# 2) 绑定新建按钮弹窗 + 提交
patch(
    r"assets\js\app.js",
    '''    $$('[data-fu-snooze]').forEach((b) => b.addEventListener('click', () => {
      toast('已改期到明天（演示态，未落库）', 'warn');
    }));
  }''',
    '''    $$('[data-fu-snooze]').forEach((b) => b.addEventListener('click', () => {
      toast('已改期到明天（演示态，未落库）', 'warn');
    }));

    $('#btn-new-fu').addEventListener('click', () => {
      openModal(`
        <h2 id="modal-title">新建跟进</h2>
        <div class="field"><label for="nf-customer">客户名称</label>
          <input id="nf-customer" placeholder="例：翡翠湾陈先生"></div>
        <div class="field"><label for="nf-type">跟进类型</label>
          <input id="nf-type" placeholder="例：报价跟进 / 方案推进" value="报价跟进"></div>
        <div class="field"><label for="nf-text">跟进内容</label>
          <textarea id="nf-text" placeholder="本次要联系客户沟通的事项"></textarea></div>
        <div class="field"><label for="nf-due">截止时间</label>
          <input id="nf-due" placeholder="例：今天 18:00 / 明天 10:00" value="今天 18:00"></div>
        <div class="modal__foot">
          <button type="button" class="btn" data-close>取消</button>
          <button type="button" class="btn btn--primary" id="nf-save">创建跟进</button>
        </div>`);
      $('#nf-save').addEventListener('click', async () => {
        const customerName = $('#nf-customer').value.trim();
        const type = $('#nf-type').value.trim() || '跟进';
        const text = $('#nf-text').value.trim();
        const due = $('#nf-due').value.trim() || '今天 18:00';
        if (!customerName) { toast('请填写客户名称', 'warn'); return; }
        if (!text) { toast('请填写跟进内容', 'warn'); return; }
        try {
          await API.createFollowup({ customerName, type, text, due, overdue: false });
          toast('跟进已创建');
          closeModal && closeModal();
          viewFollowups();
        } catch (e) {
          toast('创建失败：' + (e && e.message ? e.message : e), 'warn');
        }
      });
    });
  }''',
)

print("P2-16 frontend DONE")
