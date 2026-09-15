"""资料文件解析（P3）：把产品资料文档转成纯文本，供 AI 抽取结构化画像。

解析策略（沙箱不能装第三方库，尽量零依赖）：
- txt / md / markdown：直接解码
- docx：python-docx（环境已装）
- xlsx：zipfile + xml 正则（零依赖，OOXML 本质 zip）
- pdf：零依赖尽力提取（解压流 + 抓 Tj/TJ 文本串）；残缺则提示转 txt/md
"""
from __future__ import annotations

import io
import re
import zipfile

SUPPORTED_EXT = {".txt", ".md", ".markdown", ".docx", ".xlsx", ".pdf"}


def extract_text(filename: str, data: bytes) -> tuple[str, "str | None"]:
    """返回 (文本, 不支持/失败原因或 None)。文本超长截断到 ~12000 字符。"""
    ext = "." + (filename.rsplit(".", 1)[-1].lower() if "." in filename else "")
    if ext not in SUPPORTED_EXT:
        return "", f"不支持的文件类型：{ext}（支持 txt / md / docx / xlsx / pdf）"
    try:
        if ext in (".txt", ".md", ".markdown"):
            return _clip(_read_text(data)), None
        if ext == ".docx":
            return _clip(_read_docx(data)), None
        if ext == ".xlsx":
            return _clip(_read_xlsx(data)), None
        if ext == ".pdf":
            return _read_pdf(data)
    except Exception as e:  # noqa: BLE001
        return "", f"解析失败（{ext}）：{e}"
    return "", "未知错误"


def _clip(t: str, limit: int = 12000) -> str:
    t = (t or "").strip()
    return t if len(t) <= limit else t[:limit] + "\n…（已截断）"


def _read_text(data: bytes) -> str:
    for enc in ("utf-8", "utf-8-sig", "gbk", "latin-1"):
        try:
            return data.decode(enc)
        except Exception:  # noqa: BLE001
            continue
    return data.decode("utf-8", errors="replace")


def _read_docx(data: bytes) -> str:
    import docx  # python-docx，环境已装

    doc = docx.Document(io.BytesIO(data))
    parts: list[str] = []
    for p in doc.paragraphs:
        if p.text and p.text.strip():
            parts.append(p.text)
    for tbl in doc.tables:
        for row in tbl.rows:
            cells = [c.text.strip() for c in row.cells if c.text and c.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    return "\n".join(parts)


def _read_xlsx(data: bytes) -> str:
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()
    shared: list[str] = []
    if "xl/sharedStrings.xml" in names:
        xml = z.read("xl/sharedStrings.xml").decode("utf-8", errors="replace")
        shared = [re.sub(r"<[^>]+>", "", s) for s in re.findall(r"<t[^>]*>(.*?)</t>", xml, re.DOTALL)]
    sheets = sorted(n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
    out: list[str] = []
    for sh in sheets:
        xml = z.read(sh).decode("utf-8", errors="replace")
        row_texts: list[str] = []
        for c in re.finditer(r"<c\b([^>]*)>(.*?)</c>", xml, re.DOTALL):
            attrs, body = c.group(1), c.group(2)
            if 't="s"' in attrs:
                m = re.search(r"<v>(\d+)</v>", body)
                val = shared[int(m.group(1))] if (m and int(m.group(1)) < len(shared)) else ""
            else:
                it = re.search(r"<t>(.*?)</t>", body, re.DOTALL)
                if it:
                    val = re.sub(r"<[^>]+>", "", it.group(1))
                else:
                    vm = re.search(r"<v>(.*?)</v>", body)
                    val = vm.group(1) if vm else ""
            if val and val.strip():
                row_texts.append(val.strip())
        if row_texts:
            out.append(" | ".join(row_texts))
    return "\n".join(out)


def _read_pdf(data: bytes) -> tuple[str, "str | None"]:
    """零依赖尽力提取 PDF 文本；残缺则提示转格式。"""
    text = _pdf_text_insecure(data).strip()
    if len(text) < 30:
        return "", "PDF 文本提取不完整（环境未装 PDF 解析库）。请把内容复制为 .txt 或 .md 再导入。"
    return _clip(text), None


def _pdf_text_insecure(data: bytes) -> str:
    import zlib

    parts: list[str] = []
    raw = data.decode("latin-1", errors="replace")

    def unescape(s: str) -> str:
        s = s.replace("\\(", "(").replace("\\)", ")").replace("\\\\", "\\")
        try:
            s = s.encode("latin-1", errors="ignore").decode("unicode_escape", errors="ignore")
        except Exception:  # noqa: BLE001
            pass
        return s

    for m in re.finditer(r"stream\r?\n(.*?)endstream", raw, re.DOTALL):
        chunk = m.group(1)
        try:
            chunk = zlib.decompress(chunk.rstrip(b"\r\n")).decode("latin-1", errors="replace")
        except Exception:  # noqa: BLE001
            pass
        for s in re.finditer(r"\((?:[^()\\]|\\.)*\)\s*Tj", chunk):
            parts.append(unescape(s.group(0)[1 : s.group(0).rfind(")")]))
        for s in re.finditer(r"\[(?:[^\[\]]|\\.)*?\]\s*TJ", chunk):
            inner = s.group(0)[1 : s.group(0).rfind("]")]
            for t in re.finditer(r"\((?:[^()\\]|\\.)*\)", inner):
                parts.append(unescape(t.group(0)[1:-1]))
    return "\n".join(p for p in parts if p.strip())
