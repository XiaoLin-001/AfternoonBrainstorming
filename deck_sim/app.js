/* 午後激盪 套牌對局模擬器 — UI 層 */
(function () {
  "use strict";
  const E = window.AB.ABEngine;
  const AI = window.AB.ABAI;
  const DECKS = AI.DECKS;
  const $ = (id) => document.getElementById(id);

  const JOB_GLYPH = { ADC: "▲", AP: "●", TANK: "■", HF: "⏢", LF: "⧫", ASS: "✦", APT: "⬡", SP: "◆", CUBE: "▢", LUCKYBLOCK: "✧", MOVEO: "➤" };
  const JOB_ZH = { ADC: "射手", AP: "法師", TANK: "坦克", HF: "重裝", LF: "輕裝", ASS: "刺客", APT: "法坦", SP: "寶石", CUBE: "方塊", LUCKYBLOCK: "幸運方塊", MOVEO: "移動" };
  const COLOR_ZH = { White: "白", Red: "紅", Blue: "藍", DarkGreen: "墨綠", Purple: "紫", Orange: "橘", Green: "綠", Neutral: "" };
  const COLOR_CSS = { White: "#e8e8e8", Red: "#ff5b5b", Blue: "#5b8cff", DarkGreen: "#8aa84f", Purple: "#b06aff", Orange: "#ff9046", Green: "#5fd75f", Neutral: "#999" };

  function cardZh(name) {
    const job = E.jobOf(name), color = E.colorOf(name);
    return `${COLOR_ZH[color] || ""}${JOB_ZH[job] || name}`;
  }

  /* ================= 頁籤 ================= */
  document.querySelectorAll("nav button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("nav button").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      $("tab-" + btn.dataset.tab).classList.add("active");
    });
  });

  /* ================= 下拉選單 ================= */
  function fillDeckSelect(sel, defaultId) {
    sel.innerHTML = "";
    for (const id in DECKS) {
      const o = document.createElement("option");
      o.value = id; o.textContent = DECKS[id].label;
      sel.appendChild(o);
    }
    sel.value = defaultId;
  }
  fillDeckSelect($("w-deckA"), "blueControl");
  fillDeckSelect($("w-deckB"), "redWhiteAggro");
  fillDeckSelect($("s-deckA"), "blueControl");
  fillDeckSelect($("s-deckB"), "redWhiteAggro");

  /* =====================================================================
   * 觀戰
   * =================================================================== */
  let replay = null;     // { record, deckOf, winnerDeck }
  let cursor = 0;
  let playTimer = null;

  function buildBoardCells() {
    const board = $("board");
    board.innerHTML = "";
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.id = `cell-${x}-${y}`;
      board.appendChild(cell);
    }
  }
  buildBoardCells();

  function runWatchGame() {
    stopPlay();
    const a = $("w-deckA").value, b = $("w-deckB").value;
    const seed = parseInt($("w-seed").value || "42", 10);
    const controllers = {};
    if ($("w-ctlA").value) controllers.player1 = $("w-ctlA").value;
    if ($("w-ctlB").value) controllers.player2 = $("w-ctlB").value;
    const g = AI.runGame(a, b, seed, { record: true, controllers, campBuffs: $("w-buffs").checked });
    replay = g;
    cursor = 0;
    $("p-slider").max = g.record.length - 1;
    $("p-slider").value = 0;
    const ctlTag = (p) => g.state.controllers && g.state.controllers[p] === "camp" ? "(戰役AI)" : "";
    $("sb-n1").textContent = "玩家1・" + DECKS[g.deckOf.player1].short + ctlTag("player1");
    $("sb-n2").textContent = "玩家2・" + DECKS[g.deckOf.player2].short + ctlTag("player2");
    renderSnap();
  }

  function renderSnap() {
    if (!replay) return;
    const rec = replay.record;
    const snap = rec[cursor];

    // 棋盤
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) $(`cell-${x}-${y}`).innerHTML = "";
    for (const u of snap.board) {
      const cell = $(`cell-${u.x}-${u.y}`);
      if (!cell) continue;
      const div = document.createElement("div");
      div.className = "unit " + (u.owner === "player1" ? "p1" : u.owner === "player2" ? "p2" : "neutral") + (u.numb ? " numb" : "");
      const col = COLOR_CSS[u.color] || "#ccc";
      div.innerHTML =
        `<div class="glyph" style="color:${col}">${JOB_GLYPH[u.job] || "?"}</div>` +
        `<div class="uname">${cardZh(u.name)}</div>` +
        `<div class="stats">${u.hp}/${u.dmg}</div>` +
        (u.armor > 0 ? `<div class="armor">🛡${u.armor}</div>` : "") +
        (u.numb ? `<div class="zz">💤</div>` : "") +
        (u.moving ? `<div style="position:absolute;bottom:2px;right:4px;font-size:11px;color:var(--accent)">➤</div>` : "");
      cell.appendChild(div);
    }

    // 分數天秤 (score 負 = 玩家1 領先 → 指針向左)
    const s = Math.max(-10, Math.min(10, snap.score));
    $("sb-needle").style.left = `calc(${50 + s * 5}% - 2px)`;
    const lead = snap.score === 0 ? "持平" : (snap.score < 0 ? `玩家1 領先 ${-snap.score}` : `玩家2 領先 ${snap.score}`);
    $("sb-val").textContent = `${lead} (差 10 分獲勝)` + (snap.winner ? ` ★ ${snap.winner === "tie" ? "平手" : E.zh(snap.winner)} 獲勝` : "");
    $("sb-turn").textContent = `第 ${Math.floor(snap.turnNumber / 2) + 1} 輪・${E.zh(snap.current)} 行動`;

    // 資源
    $("r-d1").textContent = `玩家1 ${DECKS[replay.deckOf.player1].label}`;
    $("r-d2").textContent = `玩家2 ${DECKS[replay.deckOf.player2].label}`;
    renderRes("player1", "r-p1", "r-h1", snap);
    renderRes("player2", "r-p2", "r-h2", snap);

    // 戰報 (累積 0..cursor)
    const logEl = $("log");
    const lines = [];
    for (let i = 0; i <= cursor; i++) for (const l of rec[i].log) lines.push(l);
    logEl.innerHTML = lines.map(l => {
      let cls = "";
      if (l.includes("斬殺") || l.includes("死亡")) cls = "kill";
      if (l.startsWith("——") || l.includes("回合結束")) cls = "hl";
      if (l.includes("★")) cls = "star";
      return `<span class="${cls}">${l}</span>`;
    }).join("\n");
    logEl.scrollTop = logEl.scrollHeight;

    $("p-step").textContent = `${cursor + 1} / ${rec.length}`;
    $("p-slider").value = cursor;
  }

  function renderRes(p, resId, handId, snap) {
    const cards = DECKS[replay.deckOf[p]].cards;
    const extra = [];
    if (cards.some(n => E.colorOf(n) === "Blue")) extra.push(`藍球 <b>${snap.tokens[p]}</b>`);
    if (cards.some(n => E.colorOf(n) === "DarkGreen")) extra.push(`圖騰 <b>${snap.totem[p]}</b>`);
    if (cards.some(n => E.colorOf(n) === "Green") && snap.luck) extra.push(`運氣 <b>${snap.luck[p]}%</b>`);
    if ((cards.some(n => E.colorOf(n) === "Orange") || (snap.movings && snap.movings[p] > 0)) && snap.movings) extra.push(`移動點 <b>${snap.movings[p]}</b>`);
    $(resId).innerHTML =
      `刀數 <b>${snap.attacks[p]}</b>　手牌 <b>${snap.hands[p].length}</b>　牌庫 <b>${snap.piles[p].draw}</b>　棄牌 <b>${snap.piles[p].discard}</b>` +
      (extra.length ? "　" + extra.join("　") : "");
    $(handId).textContent = "手牌: " + (snap.hands[p].length ? snap.hands[p].map(cardZh).join("、") : "(無)");
  }

  function stopPlay() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; $("p-play").textContent = "▶ 播放"; }
  }
  $("p-play").addEventListener("click", () => {
    if (!replay) return;
    if (playTimer) { stopPlay(); return; }
    $("p-play").textContent = "⏸ 暫停";
    playTimer = setInterval(() => {
      if (cursor < replay.record.length - 1) { cursor++; renderSnap(); }
      else stopPlay();
    }, parseInt($("p-speed").value, 10));
  });
  $("p-prev").addEventListener("click", () => { if (replay && cursor > 0) { stopPlay(); cursor--; renderSnap(); } });
  $("p-next").addEventListener("click", () => { if (replay && cursor < replay.record.length - 1) { stopPlay(); cursor++; renderSnap(); } });
  $("p-slider").addEventListener("input", (e) => { if (replay) { stopPlay(); cursor = parseInt(e.target.value, 10); renderSnap(); } });
  $("w-run").addEventListener("click", runWatchGame);
  $("w-random").addEventListener("click", () => { $("w-seed").value = Math.floor(Math.random() * 1e6); runWatchGame(); });

  /* =====================================================================
   * 批量統計
   * =================================================================== */
  $("s-mode").addEventListener("change", () => {
    $("s-pair-wrap").style.display = $("s-mode").value === "single" ? "inline" : "none";
  });

  function setProgress(pct) { $("progress").firstElementChild.style.width = pct + "%"; }

  /* 非同步分批跑,避免凍結 UI */
  function runBatchAsync(a, b, n, baseSeed, done, progressOffset, progressScale, batchOpts) {
    batchOpts = batchOpts || {};
    const res = {
      deckA: a, deckB: b, games: n, winsA: 0, winsB: 0, ties: 0,
      winsAFirst: 0, gamesAFirst: 0, winsASecond: 0, gamesASecond: 0,
      totalTurns: 0, scoreCurves: [], lengths: [],
    };
    let i = 0;
    const CHUNK = 25;
    function step() {
      const end = Math.min(i + CHUNK, n);
      for (; i < end; i++) {
        const flip = i % 2 === 1;
        const controllers = (batchOpts.ctlA || batchOpts.ctlB) ? {
          player1: flip ? batchOpts.ctlB : batchOpts.ctlA,
          player2: flip ? batchOpts.ctlA : batchOpts.ctlB,
        } : undefined;
        const g = AI.runGame(a, b, baseSeed + i * 7919, { flip, controllers, campBuffs: batchOpts.campBuffs });
        // 依座位計勝負 (鏡像對局雙方套牌 id 相同)
        const aSeat = flip ? "player2" : "player1";
        const aWon = g.winner === aSeat;
        if (g.winner === "tie") res.ties++;
        else if (aWon) res.winsA++;
        else res.winsB++;
        const aIsP1 = !flip;
        if (aIsP1) { res.gamesAFirst++; if (aWon) res.winsAFirst++; }
        else { res.gamesASecond++; if (aWon) res.winsASecond++; }
        res.totalTurns += g.turns;
        res.lengths.push(g.turns);
        res.scoreCurves.push(g.scoreHistory.map(s => aIsP1 ? -s : s));
      }
      setProgress(progressOffset + (i / n) * progressScale);
      if (i < n) setTimeout(step, 0);
      else done(res);
    }
    step();
  }

  $("s-run").addEventListener("click", () => {
    const n = Math.max(20, Math.min(2000, parseInt($("s-n").value || "300", 10)));
    const seed = Date.now() % 100000;
    $("s-run").disabled = true;
    $("s-status").textContent = "模擬中…";
    setProgress(0);

    if ($("s-mode").value === "single") {
      const a = $("s-deckA").value, b = $("s-deckB").value;
      const batchOpts = { ctlA: $("s-ctlA").value || undefined, ctlB: $("s-ctlB").value || undefined };
      runBatchAsync(a, b, n, seed, (res) => {
        $("s-matrix-panel").style.display = "none";
        renderSingleStats([res]);
        $("s-run").disabled = false;
        $("s-status").textContent = `完成 ${n} 場`;
      }, 0, 100, batchOpts);
    } else {
      const pairs = [
        ["blueControl", "redWhiteAggro"],
        ["blueControl", "darkGreenTotem"],
        ["redWhiteAggro", "darkGreenTotem"],
      ];
      const results = [];
      let k = 0;
      function next() {
        if (k >= pairs.length) {
          renderMatrix(results);
          renderSingleStats(results);
          $("s-run").disabled = false;
          $("s-status").textContent = `完成 ${pairs.length} 組 × ${n} 場`;
          return;
        }
        const [a, b] = pairs[k];
        runBatchAsync(a, b, n, seed + k * 333331, (res) => { results.push(res); k++; next(); },
          (k / pairs.length) * 100, 100 / pairs.length);
      }
      next();
    }
  });

  function pct(x, n) { return n ? (100 * x / n) : 0; }

  function renderMatrix(results) {
    $("s-matrix-panel").style.display = "block";
    const ids = Object.keys(DECKS);
    const wr = {};   // wr[a][b] = a 對 b 勝率
    for (const r of results) {
      wr[r.deckA] = wr[r.deckA] || {};
      wr[r.deckB] = wr[r.deckB] || {};
      wr[r.deckA][r.deckB] = pct(r.winsA, r.games);
      wr[r.deckB][r.deckA] = pct(r.winsB, r.games);
    }
    let html = "<table class='matrix'><tr><th></th>";
    for (const c of ids) html += `<th>${DECKS[c].short}</th>`;
    html += "<th>平均</th></tr>";
    for (const rId of ids) {
      html += `<tr><th>${DECKS[rId].label}</th>`;
      let sum = 0, cnt = 0;
      for (const cId of ids) {
        if (rId === cId) { html += "<td style='color:#444'>—</td>"; continue; }
        const v = wr[rId] && wr[rId][cId] !== undefined ? wr[rId][cId] : null;
        if (v === null) { html += "<td>?</td>"; continue; }
        sum += v; cnt++;
        const cls = v >= 55 ? "wr-hi" : (v <= 45 ? "wr-lo" : "");
        html += `<td class="${cls}">${v.toFixed(1)}%</td>`;
      }
      html += `<td><b>${cnt ? (sum / cnt).toFixed(1) : "?"}%</b></td></tr>`;
    }
    html += "</table>";
    $("s-matrix").innerHTML = html;
  }

  /* ---------- Canvas 圖表 ---------- */
  function prepCanvas(cv) {
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = rect.width * dpr;
    cv.height = parseInt(cv.getAttribute("height"), 10) * dpr;
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, parseInt(cv.getAttribute("height"), 10));
    return { ctx, w: rect.width, h: parseInt(cv.getAttribute("height"), 10) };
  }

  const PAIR_COLORS = ["#ffc54d", "#6fd3ff", "#b78cff"];

  function renderSingleStats(results) {
    // --- 勝率長條 ---
    {
      const { ctx, w, h } = prepCanvas($("chart-bars"));
      $("c1-title").textContent = "勝率 (每列一組對戰,含先/後手拆分)";
      const rowH = Math.min(70, (h - 20) / results.length);
      ctx.font = "12px 'Microsoft JhengHei', sans-serif";
      results.forEach((r, i) => {
        const y0 = 12 + i * rowH;
        const wrA = pct(r.winsA, r.games);
        const label = `${DECKS[r.deckA].short} vs ${DECKS[r.deckB].short}`;
        ctx.fillStyle = "#9aa3b5";
        ctx.fillText(label, 8, y0 + 12);
        // 主長條
        const barY = y0 + 20, barH = 16, barW = w - 130;
        ctx.fillStyle = "#3a4254";
        ctx.fillRect(8, barY, barW, barH);
        ctx.fillStyle = PAIR_COLORS[i % 3];
        ctx.fillRect(8, barY, barW * wrA / 100, barH);
        ctx.fillStyle = "#fff";
        ctx.fillText(`${wrA.toFixed(1)}%`, 8 + barW + 8, barY + 12);
        // 先後手
        ctx.fillStyle = "#79839a";
        const f = pct(r.winsAFirst, r.gamesAFirst).toFixed(0);
        const s = pct(r.winsASecond, r.gamesASecond).toFixed(0);
        ctx.fillText(`先手 ${f}% / 後手 ${s}%`, 8, barY + barH + 13);
      });
    }
    // --- 分數走勢 ---
    {
      const { ctx, w, h } = prepCanvas($("chart-curve"));
      const padL = 34, padB = 24, padT = 12, padR = 10;
      const maxLen = Math.max(...results.map(r => Math.max(...r.scoreCurves.map(c => c.length))));
      const Y = 12;
      const xOf = (i) => padL + (i / Math.max(maxLen - 1, 1)) * (w - padL - padR);
      const yOf = (v) => padT + (1 - (v + Y) / (2 * Y)) * (h - padT - padB);
      // 軸
      ctx.strokeStyle = "#3a4254"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, yOf(0)); ctx.lineTo(w - padR, yOf(0)); ctx.stroke();
      ctx.fillStyle = "#79839a"; ctx.font = "11px sans-serif";
      for (const v of [-10, -5, 0, 5, 10]) {
        ctx.fillText(String(v), 6, yOf(v) + 4);
        ctx.strokeStyle = "rgba(58,66,84,.4)";
        ctx.beginPath(); ctx.moveTo(padL, yOf(v)); ctx.lineTo(w - padR, yOf(v)); ctx.stroke();
      }
      ctx.fillText("結算次序 (半回合)", w / 2 - 40, h - 6);
      results.forEach((r, k) => {
        const avg = [];
        for (let i = 0; i < maxLen; i++) {
          let sum = 0, cnt = 0;
          for (const c of r.scoreCurves) {
            if (i < c.length) { sum += c[i]; cnt++; }
            else if (c.length) { sum += c[c.length - 1]; cnt++; } // 結束後沿用終值
          }
          avg.push(cnt ? sum / cnt : 0);
        }
        ctx.strokeStyle = PAIR_COLORS[k % 3]; ctx.lineWidth = 2;
        ctx.beginPath();
        avg.forEach((v, i) => { const x = xOf(i), y = yOf(Math.max(-Y, Math.min(Y, v))); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
        ctx.fillStyle = PAIR_COLORS[k % 3];
        ctx.fillText(`${DECKS[r.deckA].short}領先 → vs ${DECKS[r.deckB].short}`, padL + 6, padT + 14 + k * 15);
      });
    }
    // --- 長度直方 ---
    {
      const { ctx, w, h } = prepCanvas($("chart-hist"));
      const padL = 30, padB = 26, padT = 10, padR = 10;
      const all = [];
      results.forEach((r, k) => all.push({ lens: r.lengths.map(t => Math.ceil(t / 2)), color: PAIR_COLORS[k % 3] }));
      const maxRound = Math.max(...all.flatMap(a => a.lens), 10);
      const bins = maxRound + 1;
      let maxCount = 1;
      const histos = all.map(a => {
        const hist = new Array(bins).fill(0);
        for (const l of a.lens) hist[Math.min(l, bins - 1)]++;
        maxCount = Math.max(maxCount, ...hist);
        return hist;
      });
      const bw = (w - padL - padR) / bins;
      histos.forEach((hist, k) => {
        ctx.fillStyle = all[k].color + "B0";
        hist.forEach((c, i) => {
          if (!c) return;
          const bh = (c / maxCount) * (h - padT - padB);
          const gw = bw / histos.length;
          ctx.fillRect(padL + i * bw + k * gw, h - padB - bh, gw - 1, bh);
        });
      });
      ctx.fillStyle = "#79839a"; ctx.font = "11px sans-serif";
      for (let i = 0; i <= maxRound; i += Math.ceil(maxRound / 8)) {
        ctx.fillText(String(i), padL + i * bw + bw / 2 - 3, h - 8);
      }
      ctx.fillText("輪數", w - 36, h - 8);
    }
    // --- 重點數據 ---
    {
      const lines = results.map((r, k) => {
        const wrA = pct(r.winsA, r.games).toFixed(1);
        const avgT = (r.totalTurns / r.games / 2).toFixed(1);
        return `<span style="color:${PAIR_COLORS[k % 3]}">●</span> ` +
          `<b>${DECKS[r.deckA].label}</b> 對 <b>${DECKS[r.deckB].label}</b>:` +
          `勝率 <b>${wrA}%</b>(先手 ${pct(r.winsAFirst, r.gamesAFirst).toFixed(0)}% / 後手 ${pct(r.winsASecond, r.gamesASecond).toFixed(0)}%),` +
          `平均 ${avgT} 輪分出勝負,平手 ${r.ties} 場`;
      });
      $("s-notes").innerHTML = lines.join("<br>");
    }
  }

  /* =====================================================================
   * 套牌說明
   * =================================================================== */
  const DECK_NOTES = {
    blueControl: {
      cls: "c-blue",
      pieces: [
        ["APB", "攻擊麻痺+2藍球;鎖死敵方主打手,引擎點火器"],
        ["TANKB", "10血牆;被打一下產一球,對手打不打都虧"],
        ["ADCB", "每次藍球抽牌=免費大十字攻擊(不耗刀)"],
        ["ASSB", "進場無麻痺;斬殺+2球連鎖引擎"],
        ["SPB", "進場隨機轟炸(我方場上+棄牌堆)次,唯一真清場"],
        ["HFP", "回合開始依九宮格敵數÷3補刀,解刀數瓶頸"],
      ],
      note: "前期穩守蹲角+麻痺鎖,中期藍球引擎滾卡差,SPB 一波清場後對手連續零分,梅花佈防收尾。本次分析的版本最強推薦。",
    },
    redWhiteAggro: {
      cls: "c-red",
      pieces: [
        ["TANKW", "15/1 最硬的牆,搶角鋪場"],
        ["TANKR", "被打為最近隊友+2甲(同時餵SPR)"],
        ["HFW", "9/2 九宮格,人群控制"],
        ["LFR", "造傷+1/+1 滾雪球"],
        ["APR", "麻痺+偷取100%攻擊,本版最兇單刀"],
        ["ADCW", "5/4 大十字主炮"],
      ],
      note: "傳統 8+4 快攻:抽到就丟、刀全花,用人數差搶 10 分。怕被麻痺鎖與一波清場;對懂得保護引擎的墨綠也討不到便宜——快攻的優勢建立在對手失誤上,下限高、上限有限。",
    },
    darkGreenTotem: {
      cls: "c-dkg",
      pieces: [
        ["APDKG", "攻擊麻痺+刻印5層,核心引擎"],
        ["TANKDKG", "被打刻印2層"],
        ["ADCDKG", "大十字+圖騰/4 加傷"],
        ["APTDKG", "+圖騰/2 傷害;護盾↔刻印自我循環"],
        ["LFDKG", "進場對小十字造成圖騰/4傷害"],
        ["SPDKG", "在場時刻印翻倍(可疊乘)"],
      ],
      note: "指數型後期:圖騰只進不退,拖得越久一刀越痛。在 AI 學會精算出刀價值後,對紅白快攻已能反壓(刻印加成讓中後期每刀價值碾壓);但仍被藍紫的麻痺鎖+清場剋死——引擎單位被 SPB 轟掉就斷檔。",
    },
  };

  function renderDeckCards() {
    const wrap = $("deckcards");
    wrap.innerHTML = "";
    for (const id in DECKS) {
      const d = DECKS[id];
      const counts = {};
      d.cards.forEach(c => counts[c] = (counts[c] || 0) + 1);
      const n = DECK_NOTES[id] || {
        cls: "",
        pieces: Object.keys(counts).map(c => [c, ""]),
        note: "由戰役 AI (campaign 移植) 預設操控;策略對應其派系關卡。",
      };
      const div = document.createElement("div");
      div.className = "deckcard";
      div.innerHTML =
        `<h2 class="${n.cls}">${d.label}</h2>` +
        `<div class="tag">${d.desc}</div>` +
        `<ul>` + n.pieces.map(([c, ds]) => {
          const col = COLOR_CSS[E.colorOf(c)];
          return `<li><span class="g" style="color:${col}">${JOB_GLYPH[E.jobOf(c)]}</span>` +
                 `<span class="nm">${cardZh(c)} ×${counts[c] || 0} <span style="color:#666">(${c})</span></span>` +
                 `<span class="ds">${ds}</span></li>`;
        }).join("") + `</ul>` +
        `<p>${n.note}</p>`;
      wrap.appendChild(div);
    }
  }
  renderDeckCards();

  /* 開頁直接給一場示範對局 */
  runWatchGame();
})();
