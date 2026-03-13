/* ============================================================
 *  AI Studio to DOCX - Chrome Extension
 *  v2.0 — 完整保留 AI Studio 对话格式并导出为 DOCX
 * ============================================================ */

// ─── UI 元素 ───────────────────────────────────────────────────
const tabSelect = document.getElementById("tabSelect");
const exportBtn = document.getElementById("exportBtn");
const statusEl = document.getElementById("status");

function setStatus(text, type = "info") {
  statusEl.textContent = text || "";
  statusEl.className = `status-bar show ${type}`;
  if (!text) statusEl.classList.remove("show");
}

// ─── 辅助函数 ──────────────────────────────────────────────────
function sanitizeFilename(name) {
  return (name || "AI_Studio_对话")
    .replace(/\s*[_|-]\s*Google AI Studio$/i, "") // 移除标题后的 " - Google AI Studio"
    .replace(/[\\/:\*\?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  // 按照用户要求，仅保留日期部分 YYYYMMDD
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// ─── XML 转义 ──────────────────────────────────────────────────
function escXml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ═══════════════════════════════════════════════════════════════
//  内容脚本 — 在目标页面中执行的函数
// ═══════════════════════════════════════════════════════════════
async function extractConversation() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 1. 自动滚动以加载所有惰性内容 ──
  const autoScroll = async () => {
    // 寻找可能的滚动容器（AI Studio 有时使用 main 或专门的 scroll-container）
    const scrollTargets = [document.scrollingElement];
    const main = document.querySelector("main") || document.querySelector(".chat-container") || document.body;

    // 查找具有过度滚动属性的所有容器
    main.querySelectorAll("*").forEach((el) => {
      try {
        const s = getComputedStyle(el);
        if ((s.overflowY === "auto" || s.overflowY === "scroll" || s.overflow === "auto") && el.scrollHeight > el.clientHeight + 10) {
          scrollTargets.push(el);
        }
      } catch (_) { }
    });

    for (const sc of [...new Set(scrollTargets.filter(Boolean))]) {
      let stable = 0, prevPos = -1;
      for (let i = 0; i < 40; i++) { // 增加循环次数
        const before = sc.scrollTop;
        // 向下滚一个屏幕高度
        sc.scrollTop += Math.max(500, Math.floor(sc.clientHeight * 0.9));
        await sleep(150);

        if (Math.abs(sc.scrollTop - before) < 5 || sc.scrollTop === prevPos) {
          if (++stable >= 2) break;
        } else stable = 0;
        prevPos = sc.scrollTop;
      }
      // 滚回顶部，确保采集顺序
      sc.scrollTop = 0;
      await sleep(100);
    }
  };

  // ── 2. 角色识别 ──
  const normalizeRole = (raw, element) => {
    let v = String(raw || "").toLowerCase();
    // 补补：如果属性里没写，通过类名或图标特征判断
    if (!v && element) {
      const cls = element.className || "";
      if (/user/i.test(cls) || element.querySelector(".user-avatar, .user-icon")) v = "user";
      else if (/model|assistant|gemini/i.test(cls) || element.querySelector(".model-avatar, .model-icon, .gemini-icon")) v = "model";
    }
    if (/user|human|用户/.test(v)) return "user";
    if (/model|assistant|gemini|模型/.test(v)) return "model";
    return "";
  };

  // ── 3. 递归解析 DOM 节点为结构化内容 ──
  const parseDomToBlocks = (root) => {
    const blocks = []; // 每个 block: { type, content, ... }

    const isNoisy = (s) => {
      const t = String(s || "").trim();
      if (!t) return true;
      // 排除常见的 UI 按钮文本和元数据
      const noisePatterns = [
        /^(edit|more_vert|play_circle|menu|copy|share|delete|retry|thumb_up|thumb_down|expand_more|expand_less|content_copy|volume_up|stop_circle|add_circle)$/i,
        /^\d{1,3}(,\d{3})*\s*tokens?$/i,
        /^(复制|分享|重试|编辑|查看源文本|Good response|Bad response|Copy response)$/i,
        /^1\/\d+$/ // 翻页标记
      ];
      return noisePatterns.some(p => p.test(t));
    };

    const walkInline = (node, inherited = {}) => {
      /** 返回 [{text, bold, italic, code, link}] */
      const runs = [];
      if (!node) return runs;

      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.nodeValue || "").replace(/\u00A0/g, " ");
        if (t) runs.push({ text: t, ...inherited });
        return runs;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return runs;

      const tag = node.tagName?.toUpperCase() || "";
      // 跳过噪音元素
      if (["BUTTON", "SVG", "MAT-ICON", "SCRIPT", "STYLE", "NAV"].includes(tag)) return runs;
      if (node.getAttribute("aria-hidden") === "true") return runs;

      const next = { ...inherited };
      if (tag === "STRONG" || tag === "B") next.bold = true;
      if (tag === "EM" || tag === "I") next.italic = true;
      if (tag === "CODE" && !["PRE"].includes(node.parentElement?.tagName?.toUpperCase())) next.code = true;
      if (tag === "A" && node.href) next.link = node.href;

      for (const child of node.childNodes) {
        runs.push(...walkInline(child, next));
      }
      return runs;
    };

    const mergeRuns = (runs) => {
      const merged = [];
      for (const r of runs) {
        const text = r.text || "";
        if (!text) continue;
        const prev = merged[merged.length - 1];
        if (prev && prev.bold === !!r.bold && prev.italic === !!r.italic && prev.code === !!r.code && prev.link === (r.link || undefined)) {
          prev.text += text;
        } else {
          merged.push({ text, bold: !!r.bold, italic: !!r.italic, code: !!r.code, link: r.link || undefined });
        }
      }
      // 移除前后空白但保留中间格式
      if (merged.length > 0) {
        merged[0].text = merged[0].text.replace(/^\s+/, "");
        merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/\s+$/, "");
      }
      return merged.filter(r => r.text);
    };

    const walkBlock = (container) => {
      if (!container) return;

      for (const node of container.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = (node.nodeValue || "").trim();
          if (t && !isNoisy(t)) {
            blocks.push({ type: "paragraph", runs: [{ text: t }] });
          }
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const tag = node.tagName.toUpperCase();

        // 跳过噪音
        if (["BUTTON", "SVG", "MAT-ICON", "SCRIPT", "STYLE", "NAV", "ASIDE", "HEADER", "FOOTER"].includes(tag)) continue;
        if (node.classList?.contains("actions") || node.classList?.contains("actions-container") ||
          node.classList?.contains("turn-information") || node.classList?.contains("author-label") ||
          node.classList?.contains("timestamp") || node.classList?.contains("token-count") ||
          node.tagName === "MS-CHAT-TURN-OPTIONS") continue;
        if (node.getAttribute("aria-hidden") === "true") continue;

        // 标题
        if (/^H([1-6])$/.test(tag)) {
          const level = parseInt(tag[1]);
          const runs = mergeRuns(walkInline(node));
          if (runs.length) blocks.push({ type: "heading", level, runs });
          continue;
        }

        // 代码块
        if (tag === "PRE") {
          const codeEl = node.querySelector("code") || node;
          const lang = codeEl.className?.match(/language-(\w+)/)?.[1] || "";
          const text = (codeEl.textContent || "").replace(/\u00A0/g, " ");
          if (text.trim()) blocks.push({ type: "code", text: text, language: lang });
          continue;
        }

        // 如果 pre 在一个 code-block 容器内
        if (node.querySelector("pre")) {
          // 先抽取代码块之前的标签（可能有语言标签）
          const label = node.querySelector(".code-block-decoration, .code-block-label, [class*='lang']");
          const preEl = node.querySelector("pre");
          const codeEl = preEl.querySelector("code") || preEl;
          const lang = label?.textContent?.trim() || codeEl.className?.match(/language-(\w+)/)?.[1] || "";
          const text = (codeEl.textContent || "").replace(/\u00A0/g, " ");
          if (text.trim()) blocks.push({ type: "code", text: text, language: lang });
          continue;
        }

        // 表格
        if (tag === "TABLE") {
          const rows = [];
          node.querySelectorAll("tr").forEach((tr) => {
            const cells = [];
            tr.querySelectorAll("td, th").forEach((td) => {
              const runs = mergeRuns(walkInline(td));
              cells.push({ runs, isHeader: td.tagName === "TH" });
            });
            if (cells.length) rows.push(cells);
          });
          if (rows.length) blocks.push({ type: "table", rows });
          continue;
        }

        // 列表
        if (tag === "UL" || tag === "OL") {
          const ordered = tag === "OL";
          let idx = 0;
          node.querySelectorAll(":scope > li").forEach((li) => {
            idx++;
            const runs = mergeRuns(walkInline(li));
            if (runs.length) {
              blocks.push({ type: "list", ordered, index: idx, runs });
            }
            // 嵌套列表
            const nested = li.querySelectorAll(":scope > ul > li, :scope > ol > li");
            let subIdx = 0;
            nested.forEach((sub) => {
              subIdx++;
              const subRuns = mergeRuns(walkInline(sub));
              if (subRuns.length) {
                blocks.push({ type: "list", ordered: sub.closest("ol") !== null, index: subIdx, nested: true, runs: subRuns });
              }
            });
          });
          continue;
        }

        // 引用块
        if (tag === "BLOCKQUOTE") {
          const runs = mergeRuns(walkInline(node));
          if (runs.length) blocks.push({ type: "blockquote", runs });
          continue;
        }

        // 段落
        if (tag === "P") {
          const runs = mergeRuns(walkInline(node));
          const plain = runs.map(r => r.text).join("").trim();
          if (runs.length && !isNoisy(plain)) {
            blocks.push({ type: "paragraph", runs });
          }
          continue;
        }

        // 分割线
        if (tag === "HR") {
          blocks.push({ type: "hr" });
          continue;
        }

        // LI 直接出现？
        if (tag === "LI") {
          const runs = mergeRuns(walkInline(node));
          if (runs.length) blocks.push({ type: "list", ordered: false, index: 1, runs });
          continue;
        }

        // DIV / SPAN 等容器 — 递归
        if (["DIV", "SPAN", "SECTION", "ARTICLE", "MS-PROMPT-CHUNK", "MS-CHAT-TURN-CHUNK"].includes(tag) ||
          tag.startsWith("MS-")) {
          walkBlock(node);
          continue;
        }

        // 其他元素作为段落内联
        const runs = mergeRuns(walkInline(node));
        const plain = runs.map(r => r.text).join("").trim();
        if (runs.length && !isNoisy(plain)) {
          blocks.push({ type: "paragraph", runs });
        }
      }
    };

    walkBlock(root);
    return blocks;
  };

  // ── 4. 提取对话轮次 ──
  await autoScroll();

  const main = document.querySelector("main") || document.body;
  // 查找 ms-chat-turn 或各种可能的对话块类名
  const turns = Array.from(main.querySelectorAll("ms-chat-turn, .chat-turn, .turn-outer-container, [role='listitem']"));
  const conversation = [];

  for (const turn of turns) {
    // 获取角色 - 扩大检测范围
    const roleContainer = turn.querySelector("[data-turn-role]") || turn;
    const roleRaw = roleContainer.getAttribute("data-turn-role") || "";
    const role = normalizeRole(roleRaw, turn);
    if (!role) continue;

    // 获取内容容器：支持 markdown 视图和普通 text 容器
    const turnContent = turn.querySelector(".turn-content") ||
      turn.querySelector("ms-markdown-view") ||
      turn.querySelector(".model-response-text") ||
      turn.querySelector(".prompt-text") ||
      turn;

    // 克隆并清除噪音元素（如按钮、图标、Token 数等）
    const clone = turnContent.cloneNode(true);
    clone.querySelectorAll(
      ".author-label, .timestamp, .token-count, .actions, .actions-container, .turn-information, " +
      "ms-chat-turn-options, button, svg, mat-icon, script, style, nav, .turn-footer, .copy-button"
    ).forEach((el) => el.remove());

    const contentBlocks = parseDomToBlocks(clone);

    // 检查是否有实质内容
    const hasValue = contentBlocks.some(b => {
      if (b.type === "code" || b.type === "table") return true;
      if (b.runs) return b.runs.some(r => r.text && r.text.trim().length > 0);
      return false;
    });

    if (hasValue) {
      conversation.push({ role, blocks: contentBlocks });
    }
  }

  // ── 5. Fallback: 如果 ms-chat-turn 没匹配到 ──
  if (conversation.length === 0) {
    // 尝试 aria-label 或其他标记
    const allTurns = main.querySelectorAll("[data-turn-role], [role='listitem']");
    for (const turn of allTurns) {
      const roleRaw = turn.getAttribute("data-turn-role") || turn.getAttribute("aria-label") || "";
      const role = normalizeRole(roleRaw);
      if (!role) continue;
      const contentBlocks = parseDomToBlocks(turn);
      if (contentBlocks.length) conversation.push({ role, blocks: contentBlocks });
    }
  }

  // ── 6. 最终 fallback：整个页面作为一个块 ──
  if (conversation.length === 0) {
    const contentBlocks = parseDomToBlocks(main);
    if (contentBlocks.length) {
      conversation.push({ role: "model", blocks: contentBlocks });
    }
  }

  return {
    title: document.title || "AI Studio 对话",
    url: location.href,
    conversation
  };
}

// ═══════════════════════════════════════════════════════════════
//  DOCX 构建 — 使用 OOXML
// ═══════════════════════════════════════════════════════════════

function buildDocxXml(payload) {
  const paragraphs = [];
  const hyperlinks = [];  // 收集超链接关系
  let hyperlinkCounter = 0;

  // ── 构建 run XML ──
  const runXml = (text, opts = {}) => {
    const t = escXml(text || "");
    if (!t) return "";
    const rPrParts = [];
    if (opts.bold) rPrParts.push("<w:b/><w:bCs/>");
    if (opts.italic) rPrParts.push("<w:i/><w:iCs/>");
    if (opts.code) {
      rPrParts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
      rPrParts.push('<w:sz w:val="20"/><w:szCs w:val="20"/>');
      rPrParts.push('<w:shd w:val="clear" w:color="auto" w:fill="F0F0F0"/>');
    }
    if (opts.fontSize) {
      rPrParts.push(`<w:sz w:val="${opts.fontSize}"/><w:szCs w:val="${opts.fontSize}"/>`);
    }
    if (opts.color) {
      rPrParts.push(`<w:color w:val="${opts.color}"/>`);
    }
    if (opts.underline) {
      rPrParts.push('<w:u w:val="single"/>');
    }
    const rPr = rPrParts.length ? `<w:rPr>${rPrParts.join("")}</w:rPr>` : "";
    // 为保留空格使用 xml:space="preserve"
    return `<w:r>${rPr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  };

  // ── 构建 runs (从 block.runs 转换) ──
  const runsXml = (runs, extraOpts = {}) => {
    if (!Array.isArray(runs)) return runXml("", extraOpts);
    return runs.map(r => {
      if (r.link) {
        // 超链接
        hyperlinkCounter++;
        const rId = `rLink${hyperlinkCounter}`;
        hyperlinks.push({ id: rId, url: r.link });
        const linkRuns = runXml(r.text, { ...extraOpts, bold: r.bold, italic: r.italic, code: r.code, color: "4472C4", underline: true });
        return `<w:hyperlink r:id="${rId}">${linkRuns}</w:hyperlink>`;
      }
      return runXml(r.text, { ...extraOpts, bold: r.bold, italic: r.italic, code: r.code });
    }).join("");
  };

  // ── 构建一个段落 ──
  const addParagraph = (content, pPrExtra = "") => {
    const pPr = pPrExtra ? `<w:pPr>${pPrExtra}</w:pPr>` : "";
    paragraphs.push(`<w:p>${pPr}${content}</w:p>`);
  };

  // ── 空行 ──
  const addEmptyLine = () => {
    addParagraph(runXml(""), '<w:spacing w:after="0" w:line="120" w:lineRule="auto"/>');
  };

  // ── 分割线 ──
  const addHorizontalRule = () => {
    addParagraph("", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr><w:spacing w:after="100"/>');
  };

  // ── 文档标题 ──
  const titleText = payload.title || "AI Studio 对话";
  addParagraph(
    runXml(titleText, { bold: true, fontSize: 36 }),
    '<w:spacing w:after="200"/><w:jc w:val="center"/>'
  );
  addParagraph(
    runXml(`导出时间：${new Date().toLocaleString("zh-CN")}`, { fontSize: 18, color: "888888" }),
    '<w:spacing w:after="100"/><w:jc w:val="center"/>'
  );
  if (payload.url) {
    addParagraph(
      runXml(payload.url, { fontSize: 16, color: "4472C4" }),
      '<w:spacing w:after="200"/><w:jc w:val="center"/>'
    );
  }
  addHorizontalRule();
  addEmptyLine();

  // ── 遍历对话 ──
  for (let turnIdx = 0; turnIdx < payload.conversation.length; turnIdx++) {
    const turn = payload.conversation[turnIdx];
    const isUser = turn.role === "user";
    const roleLabel = isUser ? "👤 用户" : "🤖 模型";
    const roleColor = isUser ? "2E7D32" : "1565C0";

    // 角色标题
    addParagraph(
      runXml(roleLabel, { bold: true, fontSize: 24, color: roleColor }),
      `<w:spacing w:before="240" w:after="120"/><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="${roleColor}"/></w:pBdr>`
    );

    // 内容块
    for (const block of turn.blocks) {
      switch (block.type) {
        case "heading": {
          const sizeMap = { 1: 36, 2: 32, 3: 28, 4: 26, 5: 24, 6: 22 };
          const sz = sizeMap[block.level] || 26;
          addParagraph(
            runsXml(block.runs, { bold: true, fontSize: sz }),
            `<w:spacing w:before="160" w:after="80"/>`
          );
          break;
        }

        case "paragraph": {
          addParagraph(
            runsXml(block.runs),
            '<w:spacing w:after="80" w:line="320" w:lineRule="auto"/>'
          );
          break;
        }

        case "list": {
          const bullet = block.ordered ? `${block.index}. ` : "• ";
          const indent = block.nested ? 720 : 360;
          addParagraph(
            runXml(bullet, { bold: false }) + runsXml(block.runs),
            `<w:ind w:left="${indent}"/><w:spacing w:after="40" w:line="300" w:lineRule="auto"/>`
          );
          break;
        }

        case "code": {
          // 代码块标题行（如果有语言标识）
          if (block.language) {
            addParagraph(
              runXml(block.language.toUpperCase(), { fontSize: 18, color: "FFFFFF", bold: true }),
              '<w:shd w:val="clear" w:color="auto" w:fill="3C3C3C"/><w:spacing w:after="0"/><w:ind w:left="180" w:right="180"/>' +
              '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr>'
            );
          }
          // 代码内容 — 按行拆分
          const codeLines = (block.text || "").split("\n");
          for (let li = 0; li < codeLines.length; li++) {
            const line = codeLines[li];
            const spacingAfter = li === codeLines.length - 1 ? "100" : "0";
            addParagraph(
              runXml(line || " ", { code: false, fontSize: 20 }),
              '<w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/>' +
              `<w:spacing w:after="${spacingAfter}" w:line="260" w:lineRule="auto"/>` +
              '<w:ind w:left="180" w:right="180"/>' +
              '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>'
            );
          }
          break;
        }

        case "table": {
          // OOXML 表格
          const colCount = Math.max(...block.rows.map(r => r.length));
          const colWidthTwips = Math.floor(9000 / colCount); // 大约页面宽度
          let tableXml = '<w:tbl><w:tblPr>';
          tableXml += '<w:tblStyle w:val="TableGrid"/>';
          tableXml += '<w:tblW w:w="9000" w:type="dxa"/>';
          tableXml += '<w:tblBorders>';
          tableXml += '<w:top w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>';
          tableXml += '<w:left w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>';
          tableXml += '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>';
          tableXml += '<w:right w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>';
          tableXml += '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>';
          tableXml += '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>';
          tableXml += '</w:tblBorders>';
          tableXml += '</w:tblPr>';

          // Grid
          tableXml += '<w:tblGrid>';
          for (let c = 0; c < colCount; c++) {
            tableXml += `<w:gridCol w:w="${colWidthTwips}"/>`;
          }
          tableXml += '</w:tblGrid>';

          for (let ri = 0; ri < block.rows.length; ri++) {
            const row = block.rows[ri];
            const isHeaderRow = row.some(c => c.isHeader);
            tableXml += '<w:tr>';
            if (isHeaderRow) tableXml += '<w:trPr><w:tblHeader/></w:trPr>';
            for (let ci = 0; ci < colCount; ci++) {
              const cell = row[ci] || { runs: [{ text: "" }], isHeader: false };
              const fill = isHeaderRow ? '<w:shd w:val="clear" w:color="auto" w:fill="E8E8E8"/>' : "";
              tableXml += `<w:tc><w:tcPr><w:tcW w:w="${colWidthTwips}" w:type="dxa"/>${fill}</w:tcPr>`;
              tableXml += `<w:p><w:pPr><w:spacing w:after="40"/></w:pPr>${runsXml(cell.runs, isHeaderRow ? { bold: true } : {})}</w:p>`;
              tableXml += '</w:tc>';
            }
            tableXml += '</w:tr>';
          }
          tableXml += '</w:tbl>';
          paragraphs.push(tableXml);
          // 表格后空行
          addEmptyLine();
          break;
        }

        case "blockquote": {
          addParagraph(
            runsXml(block.runs, { italic: true, color: "555555" }),
            '<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="CCCCCC"/></w:pBdr>' +
            '<w:ind w:left="360"/><w:spacing w:after="80" w:line="300" w:lineRule="auto"/>' +
            '<w:shd w:val="clear" w:color="auto" w:fill="FAFAFA"/>'
          );
          break;
        }

        case "hr": {
          addHorizontalRule();
          break;
        }

        default: {
          if (block.runs) {
            addParagraph(runsXml(block.runs), '<w:spacing w:after="80"/>');
          }
        }
      }
    }

    // 对话轮次间加空行
    addEmptyLine();
  }

  // 默认字体和段落间距样式
  const defaultStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:cs="Microsoft YaHei"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:lang w:val="zh-CN" w:eastAsia="zh-CN"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="100" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:tblPr>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>
      </w:tblBorders>
    </w:tblPr>
  </w:style>
</w:styles>`;

  // 构建 relationships（包含超链接）
  let relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  for (const hl of hyperlinks) {
    relsXml += `\n  <Relationship Id="${hl.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escXml(hl.url)}" TargetMode="External"/>`;
  }
  relsXml += `\n</Relationships>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14 wp14">
  <w:body>
    ${paragraphs.join("\n    ")}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1200" w:right="1200" w:bottom="1200" w:left="1200" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  return {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    "word/document.xml": documentXml,
    "word/styles.xml": defaultStyles,
    "word/_rels/document.xml.rels": relsXml
  };
}

// ═══════════════════════════════════════════════════════════════
//  ZIP 打包 (STORE, 无压缩)
// ═══════════════════════════════════════════════════════════════

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function writeU16LE(a, o, v) { a[o] = v & 0xff; a[o + 1] = (v >>> 8) & 0xff; }
function writeU32LE(a, o, v) { a[o] = v & 0xff; a[o + 1] = (v >>> 8) & 0xff; a[o + 2] = (v >>> 16) & 0xff; a[o + 3] = (v >>> 24) & 0xff; }

function zipStore(filesMap) {
  const enc = new TextEncoder();
  const entries = [];
  for (const [name, content] of Object.entries(filesMap)) {
    const nameBytes = enc.encode(name);
    const dataBytes = content instanceof Uint8Array ? content : enc.encode(content);
    entries.push({ nameBytes, dataBytes, crc: crc32(dataBytes), size: dataBytes.length });
  }

  let localSize = 0, centralSize = 0;
  for (const e of entries) {
    localSize += 30 + e.nameBytes.length + e.size;
    centralSize += 46 + e.nameBytes.length;
  }

  const out = new Uint8Array(localSize + centralSize + 22);
  let offset = 0, localOffset = 0;

  for (const e of entries) {
    writeU32LE(out, offset, 0x04034b50);
    writeU16LE(out, offset + 4, 20);
    writeU16LE(out, offset + 6, 0);
    writeU16LE(out, offset + 8, 0);
    writeU16LE(out, offset + 10, 0);
    writeU16LE(out, offset + 12, 0);
    writeU32LE(out, offset + 14, e.crc);
    writeU32LE(out, offset + 18, e.size);
    writeU32LE(out, offset + 22, e.size);
    writeU16LE(out, offset + 26, e.nameBytes.length);
    writeU16LE(out, offset + 28, 0);
    out.set(e.nameBytes, offset + 30);
    out.set(e.dataBytes, offset + 30 + e.nameBytes.length);
    e.localHeaderOffset = localOffset;
    const len = 30 + e.nameBytes.length + e.size;
    offset += len;
    localOffset += len;
  }

  const centralStart = offset;
  for (const e of entries) {
    writeU32LE(out, offset, 0x02014b50);
    writeU16LE(out, offset + 4, 20);
    writeU16LE(out, offset + 6, 20);
    writeU16LE(out, offset + 8, 0);
    writeU16LE(out, offset + 10, 0);
    writeU16LE(out, offset + 12, 0);
    writeU16LE(out, offset + 14, 0);
    writeU32LE(out, offset + 16, e.crc);
    writeU32LE(out, offset + 20, e.size);
    writeU32LE(out, offset + 24, e.size);
    writeU16LE(out, offset + 28, e.nameBytes.length);
    writeU16LE(out, offset + 30, 0);
    writeU16LE(out, offset + 32, 0);
    writeU16LE(out, offset + 34, 0);
    writeU16LE(out, offset + 36, 0);
    writeU32LE(out, offset + 38, 0);
    writeU32LE(out, offset + 42, e.localHeaderOffset);
    out.set(e.nameBytes, offset + 46);
    offset += 46 + e.nameBytes.length;
  }

  writeU32LE(out, offset, 0x06054b50);
  writeU16LE(out, offset + 4, 0);
  writeU16LE(out, offset + 6, 0);
  writeU16LE(out, offset + 8, entries.length);
  writeU16LE(out, offset + 10, entries.length);
  writeU32LE(out, offset + 12, centralSize);
  writeU32LE(out, offset + 16, centralStart);
  writeU16LE(out, offset + 20, 0);

  return out;
}

function buildDocxBlob(payload) {
  const parts = buildDocxXml(payload);
  return new Blob([zipStore(parts)], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
}

// ═══════════════════════════════════════════════════════════════
//  标签页管理与导出
// ═══════════════════════════════════════════════════════════════

async function loadTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const valid = tabs.filter(t => t.id && t.url && /^https?:/i.test(t.url));

  tabSelect.innerHTML = "";
  for (const tab of valid) {
    const opt = document.createElement("option");
    opt.value = String(tab.id);
    // 优先显示 AI Studio 相关标签
    const isAI = /aistudio|gemini|chatgpt|claude/i.test(tab.url);
    opt.textContent = `${isAI ? "⭐ " : ""}${tab.title || "无标题"}`;
    if (isAI) opt.style.fontWeight = "bold";
    tabSelect.appendChild(opt);
  }

  // 自动选中 AI Studio 标签
  const aiTab = valid.find(t => /aistudio\.google\.com/i.test(t.url));
  if (aiTab) tabSelect.value = String(aiTab.id);

  if (!valid.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "没有找到可用的网页标签页";
    tabSelect.appendChild(opt);
    exportBtn.disabled = true;
  } else {
    exportBtn.disabled = false;
  }
}

async function runExport() {
  const tabId = Number(tabSelect.value);
  if (!tabId) {
    setStatus("请先选择一个标签页", "error");
    return;
  }

  exportBtn.disabled = true;
  exportBtn.innerHTML = '<span class="spinner"></span> 正在导出...';
  setStatus("正在滚动页面加载全部内容...", "working");

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractConversation
    });

    const payload = result?.result;
    if (!payload || !Array.isArray(payload.conversation) || payload.conversation.length === 0) {
      throw new Error("未提取到对话内容。\n请确认：\n1. 已选择正确的 AI Studio 标签页\n2. 页面已完全加载\n3. 页面上有可见的对话内容");
    }

    setStatus(`提取到 ${payload.conversation.length} 条对话，正在生成 DOCX...`, "working");

    const blob = buildDocxBlob(payload);
    const fileName = `${nowStamp()}_${sanitizeFilename(payload.title)}.docx`;
    const blobUrl = URL.createObjectURL(blob);

    await chrome.downloads.download({
      url: blobUrl,
      filename: fileName,
      saveAs: true
    });

    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    setStatus(`✅ 导出成功！\n文件：${fileName}\n对话轮次：${payload.conversation.length}`, "success");
  } catch (err) {
    setStatus(`❌ 导出失败：${err?.message || String(err)}`, "error");
  } finally {
    exportBtn.disabled = false;
    exportBtn.innerHTML = "📄 导出 DOCX";
  }
}

// ── 事件绑定 ──
exportBtn.addEventListener("click", runExport);

window.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadTabs();
    setStatus("选择标签页后点击导出按钮", "info");
  } catch (err) {
    setStatus(`初始化失败：${err?.message || err}`, "error");
  }
});
