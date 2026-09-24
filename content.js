// カレンダー日程ピッカー
// Googleカレンダーの週/日表示でドラッグ選択した時間帯を日程候補テキストに変換する
// 注意: calendar.google.com は Trusted Types を強制しているため innerHTML は使わない

(() => {
  'use strict';

  const PREFIX = 'gcsp';
  const SNAP_KEY = `${PREFIX}-snap`;
  const FMT_KEY = `${PREFIX}-fmt`;
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  const FORMATS = {
    slash: {
      label: '8/14(木) 10:00〜11:00',
      render: (s) => `${s.m}/${s.d}(${weekday(s)}) ${time(s.start)}〜${time(s.end)}`,
    },
    kanji: {
      label: '8月14日(木) 10:00〜11:00',
      render: (s) => `${s.m}月${s.d}日(${weekday(s)}) ${time(s.start)}〜${time(s.end)}`,
    },
    hyphen: {
      label: '8/14 (木) 10:00-11:00',
      render: (s) => `${s.m}/${s.d} (${weekday(s)}) ${time(s.start)}-${time(s.end)}`,
    },
  };

  // slot: { key, y, m, d, start, end }  (start/end は 0:00 からの分)
  let slots = [];
  let active = false;
  let drag = null;
  let rafPending = false;

  // ---------- ユーティリティ ----------

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // data-datekey: (年-1970)<<9 | 月<<5 | 日
  function decodeKey(key) {
    const k = Number(key);
    return { y: (k >> 9) + 1970, m: (k >> 5) & 15, d: k & 31 };
  }

  function weekday(s) {
    return WEEKDAYS[new Date(s.y, s.m - 1, s.d).getDay()];
  }

  function time(min) {
    return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
  }

  function snapSize() {
    const v = Number(localStorage.getItem(SNAP_KEY));
    return [15, 30, 60].includes(v) ? v : 30;
  }

  function formatId() {
    const v = localStorage.getItem(FMT_KEY);
    return FORMATS[v] ? v : 'slash';
  }

  function formatAll() {
    const fmt = FORMATS[formatId()];
    return sortedSlots().map((s) => `・${fmt.render(s)}`).join('\n');
  }

  function sortedSlots() {
    return [...slots].sort((a, b) => (a.key - b.key) || (a.start - b.start));
  }

  // 週/日表示の「日カラム」を取得（背の高い gridcell のみ）
  function getColumns() {
    return [...document.querySelectorAll('div[role="gridcell"][data-datekey]')]
      .map((n) => ({ el: n, key: Number(n.getAttribute('data-datekey')), rect: n.getBoundingClientRect() }))
      .filter((c) => c.rect.height > 300 && c.rect.width > 20);
  }

  function getScroller(node) {
    let p = node.parentElement;
    while (p && p !== document.body) {
      if (p.scrollHeight > p.clientHeight + 10) {
        const oy = getComputedStyle(p).overflowY;
        if (oy === 'auto' || oy === 'scroll' || oy === 'hidden') return p;
      }
      p = p.parentElement;
    }
    return null;
  }

  // グリッドの可視領域（オーバーレイを重ねる範囲）
  function getGridRect(cols) {
    if (!cols.length) return null;
    const left = Math.min(...cols.map((c) => c.rect.left));
    const right = Math.max(...cols.map((c) => c.rect.right));
    const scroller = getScroller(cols[0].el);
    const clip = scroller
      ? scroller.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    const top = Math.max(clip.top, 0);
    const bottom = Math.min(clip.bottom, window.innerHeight);
    if (bottom - top < 50 || right - left < 50) return null;
    return { left, top, width: right - left, height: bottom - top };
  }

  function yToMinutes(col, clientY) {
    const ratio = (clientY - col.rect.top) / col.rect.height;
    return Math.max(0, Math.min(1440, ratio * 1440));
  }

  function colAt(cols, clientX) {
    return cols.find((c) => clientX >= c.rect.left && clientX < c.rect.right) || null;
  }

  // 同じ日の重複・隣接する枠をまとめる
  function mergeSlots() {
    const sorted = sortedSlots();
    const merged = [];
    for (const s of sorted) {
      const last = merged[merged.length - 1];
      if (last && last.key === s.key && s.start <= last.end) {
        last.end = Math.max(last.end, s.end);
      } else {
        merged.push({ ...s });
      }
    }
    slots = merged;
  }

  // ---------- UI 構築 ----------

  const fab = el('button', `${PREFIX}-fab`);
  fab.type = 'button';
  fab.title = '日程候補ピッカー';
  fab.appendChild(el('span', null, '📅'));
  fab.addEventListener('click', () => (active ? deactivate() : activate()));

  const overlay = el('div', `${PREFIX}-overlay`);

  const panel = el('div', `${PREFIX}-panel`);
  const head = el('div', `${PREFIX}-panel-head`);
  head.appendChild(el('span', `${PREFIX}-panel-title`, '日程候補'));
  const countEl = el('span', `${PREFIX}-count`);
  head.appendChild(countEl);
  const closeBtn = el('button', `${PREFIX}-close`, '✕');
  closeBtn.type = 'button';
  closeBtn.title = '閉じる';
  head.appendChild(closeBtn);
  panel.appendChild(head);

  panel.appendChild(el('div', `${PREFIX}-hint`, 'カレンダー上をドラッグして候補を追加。枠をクリックで削除。'));

  const listEl = el('div', `${PREFIX}-list`);
  panel.appendChild(listEl);

  const controls = el('div', `${PREFIX}-controls`);
  const snapLabel = el('label', null, '単位');
  const snapSelect = el('select', `${PREFIX}-snap`);
  for (const v of [15, 30, 60]) {
    const opt = el('option', null, `${v}分`);
    opt.value = String(v);
    snapSelect.appendChild(opt);
  }
  snapLabel.appendChild(snapSelect);
  const fmtLabel = el('label', null, '形式');
  const fmtSelect = el('select', `${PREFIX}-fmt`);
  for (const [id, f] of Object.entries(FORMATS)) {
    const opt = el('option', null, f.label);
    opt.value = id;
    fmtSelect.appendChild(opt);
  }
  fmtLabel.appendChild(fmtSelect);
  controls.append(snapLabel, fmtLabel);
  panel.appendChild(controls);

  const outArea = el('textarea', `${PREFIX}-out`);
  outArea.readOnly = true;
  outArea.rows = 5;
  outArea.placeholder = 'ここに候補テキストが表示されます';
  panel.appendChild(outArea);

  const actions = el('div', `${PREFIX}-actions`);
  const copyBtn = el('button', `${PREFIX}-copy`, 'コピー');
  copyBtn.type = 'button';
  const clearBtn = el('button', `${PREFIX}-clear`, '全クリア');
  clearBtn.type = 'button';
  actions.append(copyBtn, clearBtn);
  panel.appendChild(actions);

  snapSelect.value = String(snapSize());
  fmtSelect.value = formatId();

  closeBtn.addEventListener('click', deactivate);
  snapSelect.addEventListener('change', (e) => localStorage.setItem(SNAP_KEY, e.target.value));
  fmtSelect.addEventListener('change', (e) => {
    localStorage.setItem(FMT_KEY, e.target.value);
    renderPanel();
  });
  clearBtn.addEventListener('click', () => {
    slots = [];
    renderAll();
  });
  copyBtn.addEventListener('click', async () => {
    const text = formatAll();
    if (!text) return toast('候補がありません');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      outArea.select();
      document.execCommand('copy');
    }
    toast('コピーしました');
  });

  function toast(msg) {
    const t = el('div', `${PREFIX}-toast`, msg);
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add(`${PREFIX}-show`));
    setTimeout(() => {
      t.classList.remove(`${PREFIX}-show`);
      setTimeout(() => t.remove(), 300);
    }, 1600);
  }

  // ---------- 描画 ----------

  function renderAll() {
    renderHighlights();
    renderPanel();
  }

  function renderPanel() {
    countEl.textContent = slots.length ? `${slots.length}件` : '';
    listEl.textContent = '';
    const fmt = FORMATS[formatId()];
    sortedSlots().forEach((s) => {
      const row = el('div', `${PREFIX}-row`);
      const label = el('span', null, fmt.render(s));
      const del = el('button', null, '✕');
      del.type = 'button';
      del.title = '削除';
      del.addEventListener('click', () => {
        slots = slots.filter((x) => x !== s);
        renderAll();
      });
      row.append(label, del);
      listEl.appendChild(row);
    });
    outArea.value = formatAll();
  }

  function renderHighlights() {
    if (!active) return;
    const cols = getColumns();
    const grid = getGridRect(cols);
    if (!grid) {
      overlay.style.display = 'none';
      return;
    }
    overlay.style.display = 'block';
    overlay.style.left = `${grid.left}px`;
    overlay.style.top = `${grid.top}px`;
    overlay.style.width = `${grid.width}px`;
    overlay.style.height = `${grid.height}px`;

    overlay.textContent = '';
    const drawList = [...slots];
    if (drag && drag.moved) {
      drawList.push({ key: drag.col.key, ...decodeKey(drag.col.key), start: drag.start, end: drag.end, temp: true });
    }
    for (const s of drawList) {
      const col = cols.find((c) => c.key === s.key);
      if (!col) continue;
      const top = col.rect.top + (s.start / 1440) * col.rect.height - grid.top;
      const height = ((s.end - s.start) / 1440) * col.rect.height;
      const box = el('div', `${PREFIX}-slot${s.temp ? ` ${PREFIX}-temp` : ''}`);
      box.style.left = `${col.rect.left - grid.left + 2}px`;
      box.style.width = `${col.rect.width - 4}px`;
      box.style.top = `${top}px`;
      box.style.height = `${Math.max(height, 8)}px`;
      box.appendChild(el('span', null, `${time(s.start)}〜${time(s.end)}`));
      overlay.appendChild(box);
    }
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderHighlights();
    });
  }

  // ---------- ドラッグ選択 ----------

  overlay.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cols = getColumns();
    const col = colAt(cols, e.clientX);
    if (!col) return;
    const snap = snapSize();
    const anchor = Math.floor(yToMinutes(col, e.clientY) / snap) * snap;
    drag = {
      col,
      anchor,
      start: anchor,
      end: Math.min(anchor + snap, 1440),
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
    };
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientY - drag.startY) > 4 || Math.abs(e.clientX - drag.startX) > 4) {
      drag.moved = true;
    }
    const snap = snapSize();
    const cur = yToMinutes(drag.col, e.clientY);
    const floor = Math.floor(cur / snap) * snap;
    drag.start = Math.min(drag.anchor, floor);
    drag.end = Math.min(Math.max(drag.anchor + snap, floor + snap), 1440);
    scheduleRender();
  }, true);

  window.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      // クリック: 既存の枠なら削除、空きなら1コマ追加
      const min = yToMinutes(d.col, e.clientY);
      const hit = slots.find((s) => s.key === d.col.key && min >= s.start && min < s.end);
      if (hit) {
        slots = slots.filter((s) => s !== hit);
        renderAll();
        return;
      }
    }
    slots.push({ key: d.col.key, ...decodeKey(d.col.key), start: d.start, end: d.end });
    mergeSlots();
    renderAll();
  }, true);

  // ---------- モード切り替え ----------

  const observer = new MutationObserver((muts) => {
    // 自分の描画による変更では再描画しない（無限ループ防止）
    if (muts.every((m) => overlay.contains(m.target) || panel.contains(m.target) || m.target === overlay)) return;
    scheduleRender();
  });

  function activate() {
    const cols = getColumns();
    if (!cols.length) {
      toast('週表示または日表示に切り替えてください');
      return;
    }
    active = true;
    fab.classList.add(`${PREFIX}-on`);
    document.body.append(overlay, panel);
    document.addEventListener('scroll', scheduleRender, true);
    window.addEventListener('resize', scheduleRender);
    observer.observe(document.body, { childList: true, subtree: true });
    renderAll();
  }

  function deactivate() {
    active = false;
    drag = null;
    fab.classList.remove(`${PREFIX}-on`);
    overlay.remove();
    panel.remove();
    document.removeEventListener('scroll', scheduleRender, true);
    window.removeEventListener('resize', scheduleRender);
    observer.disconnect();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) deactivate();
  });

  document.body.appendChild(fab);
})();
