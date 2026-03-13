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

// ─── XML 转义 (增加对非法控制字符的拦截) ──────────────────────────
function escXml(text) {
  return String(text ?? "")
    // 移除 Word 不支持的控制字符 (\x00-\x08, \x0B, \x0C, \x0E-\x1F)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
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

  // ── 1. 角色识别 ──
  const normalizeRole = (raw, element) => {
    let v = String(raw || "").toLowerCase();
    if (!v && element) {
      const cls = element.className || "";
      if (/user/i.test(cls) || element.querySelector(".user-avatar, .user-icon")) v = "user";
      else if (/model|assistant|gemini/i.test(cls) || element.querySelector(".model-avatar, .model-icon, .gemini-icon")) v = "model";
    }
    if (/user|human|用户/.test(v)) return "user";
    if (/model|assistant|gemini|模型/.test(v)) return "model";
    return "";
  };

  const isNoisy = (s) => {
    const t = String(s || "").trim();
    if (!t) return true;
    const noisePatterns = [
      /^(edit|more_vert|play_circle|menu|copy|share|delete|retry|thumb_up|thumb_down|expand_more|expand_less|content_copy|volume_up|stop_circle|add_circle)$/i,
      /^\d{1,3}(,\d{3})*\s*tokens?$/i,
      /^(复制|分享|重试|编辑|查看源文本|Good response|Bad response|Copy response)$/i,
      /^Thinking\.\.\./i,
      /^Sources$/i,
      /^Google Search Suggestions$/i,
      /Display of Search Suggestions is required/i,
      /^(User|Model)\s*[•·]\s*\d{1,2}:\d{2}/i
    ];
    return noisePatterns.some(p => p.test(t));
  };

  const parseDomToBlocks = (root) => {
    const blocks = [];
    const walkInline = (node, inherited = {}) => {
      const runs = [];
      if (!node) return runs;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.nodeValue || "").replace(/\u00A0/g, " ");
        if (t) runs.push({ text: t, ...inherited });
        return runs;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return runs;
      const tag = node.tagName?.toUpperCase() || "";
      // UL/OL 交给 walkBlock 处理，walkInline 里跳过，防止嵌套列表文本被拼成一行
      if (["BUTTON", "SVG", "MAT-ICON", "SCRIPT", "STYLE", "NAV", "UL", "OL"].includes(tag)) return runs;
      if (node.getAttribute("aria-hidden") === "true") return runs;
      const next = { ...inherited };
      if (tag === "STRONG" || tag === "B") next.bold = true;
      if (tag === "EM" || tag === "I") next.italic = true;
      if (tag === "CODE" && !["PRE"].includes(node.parentElement?.tagName?.toUpperCase())) next.code = true;
      if (tag === "A" && node.href) next.link = node.href;
      for (const child of node.childNodes) runs.push(...walkInline(child, next));
      return runs;
    };

    const mergeRuns = (runs) => {
      const merged = [];
      for (const r of runs) {
        if (!r.text) continue;
        const prev = merged[merged.length - 1];
        if (prev && prev.bold === !!r.bold && prev.italic === !!r.italic && prev.code === !!r.code && prev.link === (r.link || undefined)) {
          prev.text += r.text;
        } else merged.push({ ...r });
      }
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
          if (t && !isNoisy(t)) blocks.push({ type: "paragraph", runs: [{ text: t }] });
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const tag = node.tagName.toUpperCase();
        // 绝对不能跳过的正文关键路径
        if (node.classList?.contains("actions") || node.classList?.contains("actions-container") ||
          node.classList?.contains("turn-information") || node.classList?.contains("author-label") ||
          node.getAttribute("aria-hidden") === "true") continue;

        if (/^H([1-6])$/.test(tag)) {
          const runs = mergeRuns(walkInline(node));
          const headingText = runs.map(r => r.text).join("");
          // 过滤掉 Google Search Suggestions 等噪音标题
          if (runs.length && !isNoisy(headingText)) blocks.push({ type: "heading", level: parseInt(tag[1]), runs });
        } else if (tag === "PRE") {
          const codeEl = node.querySelector("code") || node;
          const lang = codeEl.className?.match(/language-(\w+)/)?.[1] || "";
          const text = (codeEl.textContent || "").replace(/\u00A0/g, " ");
          if (text.trim()) blocks.push({ type: "code", text, language: lang });
        } else if (tag === "TABLE") {
          const rows = [];
          node.querySelectorAll("tr").forEach(tr => {
            const cells = [];
            tr.querySelectorAll("td, th").forEach(td => cells.push({ runs: mergeRuns(walkInline(td)), isHeader: td.tagName === "TH" }));
            if (cells.length) rows.push(cells);
          });
          if (rows.length) blocks.push({ type: "table", rows });
        } else if (tag === "UL" || tag === "OL") {
          // 递归处理列表，支持嵌套层级；depth=0 用实心圆，depth>0 用空心圆
          const processListNode = (listEl, depth) => {
            const isOrdered = listEl.tagName.toUpperCase() === "OL";
            // 从直接子节点中找 LI，穿透 ms-cmark-node 等自定义容器，但不进入嵌套 UL/OL
            const findDirectLIs = (container) => {
              const result = [];
              for (const child of container.childNodes) {
                if (child.nodeType !== Node.ELEMENT_NODE) continue;
                const ct = child.tagName.toUpperCase();
                if (ct === "LI") {
                  result.push(child);
                } else if (ct !== "UL" && ct !== "OL") {
                  result.push(...findDirectLIs(child));
                }
              }
              return result;
            };
            const directLIs = findDirectLIs(listEl);
            directLIs.forEach((li, idx) => {
              const runs = mergeRuns(walkInline(li));
              if (runs.length) blocks.push({ type: "list", ordered: isOrdered, index: idx + 1, runs, depth });
              // 递归处理 LI 内的嵌套 UL/OL
              const findNestedLists = (el) => {
                for (const child of el.children) {
                  const ct = child.tagName.toUpperCase();
                  if (ct === "UL" || ct === "OL") {
                    processListNode(child, depth + 1);
                  } else if (ct !== "LI") {
                    findNestedLists(child);
                  }
                }
              };
              findNestedLists(li);
            });
          };
          processListNode(node, 0);
        } else if (tag === "LI") {
          // 兜底处理：不在 UL 内的孤立 LI
          const runs = mergeRuns(walkInline(node));
          if (runs.length) blocks.push({ type: "list", ordered: false, index: 1, runs });
        } else if (tag === "BLOCKQUOTE") {
          const runs = mergeRuns(walkInline(node));
          if (runs.length) blocks.push({ type: "blockquote", runs });
        } else if (tag === "P") {
          const runs = mergeRuns(walkInline(node));
          if (runs.length && !isNoisy(runs.map(r => r.text).join(""))) {
            blocks.push({ type: "paragraph", runs });
          }
        } else {
          // 关键：对于所有容器（DIV, SECTION, MS-*, SPAN等），永远进入内部递归，不做外部过滤
          walkBlock(node);
        }
      }
    };
    walkBlock(root);
    return blocks;
  };

  // ── 2. 边滚动边采集逻辑 ──
  const findChatScrollContainer = () => {
    const match = document.querySelector("ms-autoscroll-container, cdk-virtual-scroll-viewport");
    if (match) return match;
    const chatView = document.querySelector("ms-chat-view");
    if (chatView) {
      const scrollable = Array.from(chatView.querySelectorAll("div")).find(d => d.scrollHeight > d.clientHeight + 10);
      if (scrollable) return scrollable;
    }
    return document.scrollingElement;
  };

  const sc = findChatScrollContainer();
  const allCollectedTurns = []; // 严格按视觉先后顺序采集

  if (sc) {
    console.log("正在重置到对话顶部...");

    const performReset = () => {
      sc.scrollTop = 0;
      if (sc.scrollTo) sc.scrollTo({ top: 0, behavior: 'instant' });
      let parent = sc.parentElement;
      while (parent && parent !== document.body) {
        if (parent.scrollTop > 0) parent.scrollTop = 0;
        parent = parent.parentElement;
      }
      window.scrollTo(0, 0);
    };

    // 强力归零校验循环 (确保从第一轮开始)
    for (let r = 0; r < 10; r++) {
      performReset();
      await sleep(200);
      if (sc.scrollTop < 5) break;
    }
    console.log("[核心] 归零成功，同步中...");
    await sleep(2000);

    let lastScrollTop = -1;
    let noMoveCount = 0;

    // 步进式顺序扫描
    for (let i = 0; i < 150; i++) {
      // 提取视口快照并物理垂直排序
      const currentSnapshot = Array.from(sc.querySelectorAll("ms-chat-turn, .chat-turn, .turn-outer-container"))
        .filter(el => {
          const rect = el.getBoundingClientRect();
          const cRect = sc.getBoundingClientRect();
          // 只采集高度足够且【其顶部已进入当前滚动视口】的内容
          // 加上 rect.bottom > cRect.top 确保它没滚出视口顶端
          return rect.height > 25 && rect.top < cRect.bottom - 5 && rect.bottom > cRect.top + 5;
        })
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
        .map(turn => {
          const roleContainer = turn.querySelector("[data-turn-role]") || turn;
          const role = normalizeRole(roleContainer.getAttribute("data-turn-role"), turn);
          if (!role) return null;

          const turnContent = turn.querySelector(".turn-content") || turn.querySelector("ms-markdown-view") || turn;
          const textSum = turnContent.textContent.trim();
          if (!textSum) return null;

          // 生成极其唯一的指纹 (首尾结合)
          const finger = `${role}_${textSum.slice(0, 50)}_${textSum.slice(-50)}_${textSum.length}`;
          return { finger, role, turnContent };
        })
        .filter(Boolean);

      // 顺次接龙追加
      for (const item of currentSnapshot) {
        if (!allCollectedTurns.some(t => t.finger === item.finger)) {
          const clone = item.turnContent.cloneNode(true);
          // 清理 UI 元素、思考块、引用来源、搜索建议等
          clone.querySelectorAll(".author-label, .timestamp, .token-count, .actions, button, svg, mat-icon, ms-thought-chunk, ms-thought-block, ms-collapsible-thought-block, .thought-container, .thought-content, ms-grounding-info, ms-grounding-chunk, ms-grounding-metadata, ms-search-suggestions, ms-search-suggestion, ms-grounding-web-search-queries, .grounding-panel, .search-suggestions-container").forEach(el => el.remove());

          const contentBlocks = parseDomToBlocks(clone);
          if (contentBlocks.length) {
            allCollectedTurns.push({ finger: item.finger, role: item.role, blocks: contentBlocks });
            console.log(`[同步进度] 已捕获 ${item.role} 消息 (总计: ${allCollectedTurns.length})`);
          }
        }
      }

      // 继续往下滚
      lastScrollTop = sc.scrollTop;
      sc.scrollTop += Math.floor(sc.clientHeight * 0.7); // 适度重叠以防漏词
      await sleep(650); // 必须等待，确保虚拟列表稳定挂载

      if (Math.abs(sc.scrollTop - lastScrollTop) < 3) {
        if (++noMoveCount >= 3) break;
      } else {
        noMoveCount = 0;
      }
    }
  }

  return {
    title: document.title || "AI Studio 对话",
    url: location.href,
    conversation: allCollectedTurns
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

  // ── 构建一个段落 (严格遵守 OOXML 内部顺序规范) ──
  const addParagraph = (content, opts = {}) => {
    // 规范化的 pPr 顺序: pStyle -> (spacing -> ind -> jc) -> shd -> rPr
    let pPrParts = "";
    if (opts.spacing) pPrParts += opts.spacing;
    if (opts.ind) pPrParts += opts.ind;
    if (opts.jc) pPrParts += opts.jc;
    if (opts.shd) pPrParts += opts.shd;
    if (opts.rPr) pPrParts += `<w:rPr>${opts.rPr}</w:rPr>`;

    const pPr = pPrParts ? `<w:pPr>${pPrParts}</w:pPr>` : "";
    paragraphs.push(`<w:p>${pPr}${content}</w:p>`);
  };

  // ── 快捷样式方法 ──
  const addEmptyLine = () => {
    addParagraph(runXml(""), { spacing: '<w:spacing w:after="0" w:line="120" w:lineRule="auto"/>' });
  };

  const addHorizontalRule = () => {
    addParagraph("", {
      spacing: '<w:spacing w:after="100"/>',
      shd: '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr>' // 借用 Bdr 实现分割线
    });
  };

  // ── 文档标题 ──
  const titleText = payload.title || "AI Studio 对话";
  addParagraph(
    runXml(titleText, { bold: true, fontSize: 36 }),
    { spacing: '<w:spacing w:after="200"/>', jc: '<w:jc w:val="center"/>' }
  );
  addParagraph(
    runXml(`导出时间：${new Date().toLocaleString("zh-CN")}`, { fontSize: 18, color: "888888" }),
    { spacing: '<w:spacing w:after="200"/>', jc: '<w:jc w:val="center"/>' }
  );
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
      {
        spacing: '<w:spacing w:before="240" w:after="120"/>',
        shd: `<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="${roleColor}"/></w:pBdr>`
      }
    );

    // 内容块
    for (const block of turn.blocks) {
      switch (block.type) {
        case "heading": {
          const sizeMap = { 1: 36, 2: 32, 3: 28, 4: 26, 5: 24, 6: 22 };
          const sz = sizeMap[block.level] || 26;
          addParagraph(
            runsXml(block.runs, { bold: true, fontSize: sz }),
            { spacing: `<w:spacing w:before="160" w:after="80"/>` }
          );
          break;
        }

        case "paragraph": {
          addParagraph(
            runsXml(block.runs),
            { spacing: '<w:spacing w:after="80" w:line="320" w:lineRule="auto"/>' }
          );
          break;
        }

        case "list": {
          const depth = block.depth || 0;
          // depth=0: 实心圆 •，depth>0: 空心圆 ○，有序列表用数字
          const bullet = block.ordered ? `${block.index}. ` : (depth > 0 ? "\u25CB " : "\u2022 ");
          const indentLeft = 360 + depth * 360; // 每级缩进 360 twips (~0.25英寸)
          addParagraph(
            runXml(bullet, { bold: false }) + runsXml(block.runs),
            {
              ind: `<w:ind w:left="${indentLeft + 360}" w:hanging="360"/>`,
              spacing: '<w:spacing w:after="40" w:line="300" w:lineRule="auto"/>'
            }
          );
          break;
        }

        case "code": {
          // 代码块标题行（如果有语言标识）
          if (block.language) {
            addParagraph(
              runXml(block.language.toUpperCase(), { fontSize: 18, color: "FFFFFF", bold: true }),
              {
                spacing: '<w:spacing w:after="0"/>',
                ind: '<w:ind w:left="180" w:right="180"/>',
                shd: '<w:shd w:val="clear" w:color="auto" w:fill="3C3C3C"/>',
                rPr: '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'
              }
            );
          }
          // 代码内容 — 按行拆分
          const codeLines = (block.text || "").split("\n");
          for (let li = 0; li < codeLines.length; li++) {
            const line = codeLines[li];
            const spacingAfter = li === codeLines.length - 1 ? "100" : "0";
            addParagraph(
              runXml(line || " ", { code: false, fontSize: 20 }),
              {
                spacing: `<w:spacing w:after="${spacingAfter}" w:line="260" w:lineRule="auto"/>`,
                ind: '<w:ind w:left="180" w:right="180"/>',
                shd: '<w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/>',
                rPr: '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/>'
              }
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
            {
              spacing: '<w:spacing w:after="80" w:line="300" w:lineRule="auto"/>',
              ind: '<w:ind w:left="360"/>',
              shd: '<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="CCCCCC"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="FAFAFA"/>'
            }
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
