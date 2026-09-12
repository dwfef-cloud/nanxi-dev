# task0-route-patch.ps1
# 修改 app.js：清理路由表旧条目 + 更新重定向映射 + 添加占位函数
$ErrorActionPreference = "Stop"
$path = "D:\nanxi-dev\frontend\assets\js\app.js"
$lines = [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)

# ── 1. 找到路由表起止行 ──
$routeStart = -1
$routeEnd = -1
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match '^\s*const routes = \{') { $routeStart = $i }
    if ($routeStart -ge 0 -and $routeEnd -lt 0 -and $lines[$i] -match '^\s*\};') { $routeEnd = $i; break }
}
Write-Output "Routes block: lines $($routeStart+1)-$($routeEnd+1)"

# ── 2. 找到 legacyRedirects 起止行 ──
$redirStart = -1
$redirEnd = -1
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match 'legacyRedirects = \{') { $redirStart = $i }
    if ($redirStart -ge 0 -and $redirEnd -lt 0 -and $lines[$i] -match '^\s*\};') { $redirEnd = $i; break }
}
Write-Output "Redirects block: lines $($redirStart+1)-$($redirEnd+1)"

# ── 3. 构造新路由表（含占位函数） ──
$newRouteBlock = @(
'  /* ══════════ 新模块占位渲染函数（后续由 interact.js / customers.js / reports.js / settings.js 覆盖 window.renderXxx） ══════════ */',
'  function renderInteract(params) {',
'    main.innerHTML = `<div class="view"><div class="empty"><p>互动中心加载中…</p><p style="color:var(--ink-faint);font-size:12px;margin-top:4px">模块开发中 · 占位界面</p></div></div>`;',
'  }',
'  function renderCustomers(params) {',
'    main.innerHTML = `<div class="view"><div class="empty"><p>客户管理加载中…</p><p style="color:var(--ink-faint);font-size:12px;margin-top:4px">模块开发中 · 占位界面</p></div></div>`;',
'  }',
'  function renderReports(params) {',
'    main.innerHTML = `<div class="view"><div class="empty"><p>数据报表加载中…</p><p style="color:var(--ink-faint);font-size:12px;margin-top:4px">模块开发中 · 占位界面</p></div></div>`;',
'  }',
'  function renderSettings(params) {',
'    main.innerHTML = `<div class="view"><div class="empty"><p>设置加载中…</p><p style="color:var(--ink-faint);font-size:12px;margin-top:4px">模块开发中 · 占位界面</p></div></div>`;',
'  }',
'  window.renderInteract = renderInteract;',
'  window.renderCustomers = renderCustomers;',
'  window.renderReports = renderReports;',
'  window.renderSettings = renderSettings;',
'',
'  const routes = {',
'    workbench: viewWorkbench,',
'    leads: viewLeads,',
'    interact: (p) => window.renderInteract(p),',
'    scripts: viewScripts,',
'    customers: (p) => window.renderCustomers(p),',
'    reports: (p) => window.renderReports(p),',
'    settings: (p) => window.renderSettings(p),',
'    notifications: viewNotifications,',
'  };'
)

# ── 4. 构造新重定向映射 ──
$newRedirBlock = @(
'    // 旧路由重定向映射（13条，书签兼容）',
'    const legacyRedirects = {',
"      'dm':       'interact?type=dm',",
"      'dm-inbox': 'interact?type=inbox',",
"      'comments': 'interact?type=comment',",
"      'followups': 'customers?tab=followups',",
"      'funnel':      'reports?tab=funnel',",
"      'attribution': 'reports?tab=attribution',",
"      'accounts': 'settings?tab=accounts',",
"      'health':   'settings?tab=accounts',",
"      'crawl':    'settings?tab=crawl',",
"      'risk':     'settings?tab=compliance',",
"      'monitor':  'settings?tab=monitor',",
"      'wizard':   'settings?tab=system',",
"      'backup':   'settings?tab=system',",
'    };'
)

# ── 5. 组装新文件内容（先替换靠后的 redir，再替换靠前的 route，避免行号偏移） ──
# 注意：redir 在 route 之后，先替换 redir 不影响 route 的行号
$result = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($i -eq $redirStart) {
        # 跳过旧的注释行 "// 旧路由重定向映射"（如果存在）
        # redirStart 指向 "const legacyRedirects = {"，前一行可能是注释
        # 我们检查前一行是否是注释
        if ($i -gt 0 -and $lines[$i-1] -match '旧路由重定向') {
            # 注释行已经在上一次迭代中被添加了，需要移除
            $result.RemoveAt($result.Count - 1)
        }
        foreach ($l in $newRedirBlock) { $result.Add($l) }
        $i = $redirEnd  # 跳过到旧块结束
        continue
    }
    if ($i -eq $routeStart) {
        foreach ($l in $newRouteBlock) { $result.Add($l) }
        $i = $routeEnd
        continue
    }
    $result.Add($lines[$i])
}

# ── 6. 写回文件（UTF-8 no BOM，CRLF） ──
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$content = [string]::Join("`r`n", $result) + "`r`n"
[System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
Write-Output "Done. Original lines: $($lines.Length), New lines: $($result.Count)"
