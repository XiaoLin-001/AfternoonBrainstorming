/* 實戰助手 — 即時鏡像真實對局 + 深度搜索建議 */
(function () {
  "use strict";
  const E = window.AB.ABEngine;
  const AI = window.AB.ABAI;
  const S = window.AB.ABSearch;
  const $ = (id) => document.getElementById(id);

  const JOB_GLYPH = { ADC: "▲", AP: "●", TANK: "■", HF: "⏢", LF: "⧫", ASS: "✦", APT: "⬡", SP: "◆", CUBE: "▢", LUCKYBLOCK: "✧", MOVEO: "➤" };
  const JOB_ZH = { ADC: "射手", AP: "法師", TANK: "坦克", HF: "重裝", LF: "輕裝", ASS: "刺客", APT: "法坦", SP: "寶石", CUBE: "方塊", LUCKYBLOCK: "幸運方塊", MOVEO: "移動" };
  const COLOR_ZH = { White: "白", Red: "紅", Blue: "藍", DarkGreen: "墨綠", Purple: "紫", Orange: "橘", Green: "綠", Neutral: "" };
  const COLOR_CSS = { White: "#e8e8e8", Red: "#ff5b5b", Blue: "#5b8cff", DarkGreen: "#8aa84f", Purple: "#b06aff", Orange: "#ff9046", Green: "#5fd75f", Neutral: "#999" };
  const cardZh = (n) => `${COLOR_ZH[E.colorOf(n)] || ""}${JOB_ZH[E.jobOf(n)] || n}`;

  const ADV = {
    lastUpdatedAt: 0,
    lastSearchKey: "",
    st: null,
    meta: null,
    demo: false,
    searching: false,
  };

  /* ---------- 棋盤 ---------- */
  function buildBoard() {
    const board = $("adv-board");
    board.innerHTML = "";
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.id = `acell-${x}-${y}`;
      board.appendChild(cell);
    }
  }
  buildBoard();

  function renderBoard(st, highlight) {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const cell = $(`acell-${x}-${y}`);
      cell.innerHTML = "";
      cell.style.boxShadow = "";
    }
    for (const u of E.allCards(st).filter(c => c.hp > 0)) {
      const cell = $(`acell-${u.x}-${u.y}`);
      if (!cell) continue;
      const div = document.createElement("div");
      div.className = "unit " + (u.owner === "player1" ? "p1" : u.owner === "player2" ? "p2" : "neutral") +
                      (u.numbness ? " numb" : "");
      const col = COLOR_CSS[u.color] || "#ccc";
      div.innerHTML =
        `<div class="glyph" style="color:${col}">${JOB_GLYPH[u.job] || "?"}</div>` +
        `<div class="uname">${cardZh(u.name)}</div>` +
        `<div class="stats">${u.hp}/${u.dmg + u.extraDamage}</div>` +
        (u.armor > 0 ? `<div class="armor">🛡${u.armor}</div>` : "") +
        (u.numbness ? `<div class="zz">💤</div>` : "") +
        (u.moving ? `<div style="position:absolute;bottom:2px;right:4px;font-size:11px;color:var(--accent)">➤</div>` : "");
      cell.appendChild(div);
    }
    if (highlight) {
      for (const [x, y] of highlight) {
        const cell = $(`acell-${x}-${y}`);
        if (cell) cell.style.boxShadow = "0 0 0 3px var(--accent) inset";
      }
    }
  }

  function renderRes(st, p, dId, rId, hId) {
    const me = $("adv-seat").value;
    $(dId).textContent = `${E.zh(p)}${p === me ? "・你" : "・對手"}`;
    const pl = st.players[p];
    const extra = [];
    const deckL = (st.deckLists && st.deckLists[p]) || [];
    if (deckL.some(n => E.colorOf(n) === "Blue")) extra.push(`藍球 <b>${st.tokens[p]}</b>`);
    if (deckL.some(n => E.colorOf(n) === "DarkGreen")) extra.push(`圖騰 <b>${st.totem[p]}</b>`);
    if (deckL.some(n => E.colorOf(n) === "Green")) extra.push(`運氣 <b>${st.luck[p]}%</b>`);
    if (st.movings[p] > 0 || deckL.some(n => E.colorOf(n) === "Orange")) extra.push(`移動點 <b>${st.movings[p]}</b>`);
    $(rId).innerHTML =
      `刀數 <b>${st.attacks[p]}</b>　手牌 <b>${pl.hand.length}</b>　牌庫 <b>${pl.drawPile.length}</b>　棄牌 <b>${pl.discard.length}</b>` +
      (extra.length ? "　" + extra.join("　") : "");
    $(hId).textContent = "手牌: " + (pl.hand.length ? pl.hand.map(cardZh).join("、") : "(無)");
  }

  function renderState() {
    const st = ADV.st;
    if (!st) return;
    const s = Math.max(-10, Math.min(10, st.score));
    $("adv-needle").style.left = `calc(${50 + s * 5}% - 2px)`;
    const lead = st.score === 0 ? "持平" : (st.score < 0 ? `玩家1 領先 ${-st.score}` : `玩家2 領先 ${st.score}`);
    $("adv-scoreval").textContent = `${lead} (差 10 分獲勝)` + (st.winner ? ` ★ 對局結束` : "");
    const cur = E.currentPlayer(st);
    const me = $("adv-seat").value;
    $("adv-turninfo").textContent = `第 ${Math.floor(st.turnNumber / 2) + 1} 輪・${cur === me ? "你的回合" : "對手回合"}`;
    $("adv-n1").textContent = "玩家1" + (me === "player1" ? "・你" : "");
    $("adv-n2").textContent = "玩家2" + (me === "player2" ? "・你" : "");
    renderRes(st, "player1", "adv-rd1", "adv-rp1", "adv-rh1");
    renderRes(st, "player2", "adv-rd2", "adv-rp2", "adv-rh2");
    renderBoard(st, null);
    if (ADV.meta && ADV.meta.lastEvents) {
      $("adv-events").textContent = ADV.meta.lastEvents.join("\n");
      $("adv-events").scrollTop = $("adv-events").scrollHeight;
    }
  }

  /* ---------- 搜索與建議 ---------- */
  function actionCells(a) {
    const cells = [];
    if (a.x !== undefined && a.y !== undefined) cells.push([a.x, a.y]);
    return cells;
  }

  function runSearch() {
    const st = ADV.st;
    if (!st || st.winner) return;
    const me = $("adv-seat").value;
    if (E.currentPlayer(st) !== me) {
      $("adv-first").textContent = "等待對手行動…";
      $("adv-plan").innerHTML = "";
      $("adv-warning").style.display = "none";
      $("adv-alts").textContent = "";
      $("adv-searchmeta").textContent = "";
      return;
    }
    if (ADV.searching) return;
    ADV.searching = true;
    $("adv-first").textContent = "深度搜索中…";
    setTimeout(() => {
      try {
        const TIERS = { 4: { beam: 5, maxDepth: 7 }, 6: { beam: 9, maxDepth: 9 }, 10: { beam: 14, maxDepth: 10 } };
        const tier = TIERS[parseInt($("adv-beam").value, 10)] || TIERS[6];
        const beam = tier.beam;
        const r = S.deepSearch(st, me, tier);
        $("adv-first").textContent = "→ " + r.firstAction.label;
        const planEl = $("adv-plan");
        planEl.innerHTML = "";
        for (const a of r.bestPlan) {
          const li = document.createElement("li");
          li.innerHTML = a.label +
            (a.events && a.events.length
              ? `<div style="color:var(--dim);font-size:11.5px">${a.events.join("・")}</div>` : "");
          planEl.appendChild(li);
        }
        const warn = $("adv-warning");
        if (r.winFound) {
          warn.style.display = "block";
          warn.style.borderColor = "#7dde8b";
          warn.style.background = "rgba(125,222,139,.12)";
          warn.textContent = "🏆 找到致勝序列!照計畫執行本回合可直接獲勝。";
        } else if (r.loseUnavoidable) {
          warn.style.display = "block";
          warn.style.borderColor = "var(--p2)";
          warn.style.background = "rgba(255,99,99,.12)";
          warn.textContent = "⚠ 對手下回合結算可獲勝,搜索未找到反制。以下為最大抵抗方案 (否定對方最多得分)。";
        } else {
          warn.style.display = "none";
        }
        $("adv-alts").innerHTML = r.alternatives.length
          ? "替代第一步: " + r.alternatives.map(a => `${a.first} <span style="color:#5d6678">(${a.score.toFixed(1)})</span>`).join("　")
          : "";
        $("adv-searchmeta").textContent =
          `束寬 ${beam}・展開 ${r.nodesExpanded} 節點・${r.elapsedMs}ms・評估 ${r.finalScore > 1e5 ? "必勝" : r.finalScore < -1e5 ? "劣勢" : r.finalScore.toFixed(1)}`;
        renderBoard(st, actionCells(r.firstAction));
      } finally {
        ADV.searching = false;
      }
    }, 20);
  }

  /* ---------- 輪詢橋接器 ---------- */
  async function poll() {
    if (ADV.demo) return;
    try {
      const res = await fetch("./advisor_state.json?ts=" + Date.now(), { cache: "no-store" });
      if (!res.ok) { $("adv-status").textContent = "等待橋接器 (advisor_state.json 不存在) — 先執行 node advisor_bridge.js"; return; }
      const data = await res.json();
      if (data.status === "waiting") {
        $("adv-status").textContent = `橋接器運作中,等待對局開始… (${new Date(data.updatedAt).toLocaleTimeString()})`;
        return;
      }
      if (data.status === "error") {
        $("adv-status").textContent = "橋接器: " + data.error;
        return;
      }
      if (data.updatedAt === ADV.lastUpdatedAt) return;   // 無變化
      ADV.lastUpdatedAt = data.updatedAt;
      ADV.st = E.loadState(data.stateDump);
      ADV.meta = data.meta;
      $("adv-status").textContent =
        `來源 ${data.sourceFile}・動作 ${data.meta.actionCount}・校正 ${data.meta.corrections}・${new Date(data.updatedAt).toLocaleTimeString()}`;
      renderState();
      const key = data.updatedAt + "|" + $("adv-seat").value + "|" + $("adv-beam").value;
      if (key !== ADV.lastSearchKey) {
        ADV.lastSearchKey = key;
        runSearch();
      }
    } catch (e) {
      $("adv-status").textContent = "等待橋接器… (" + e.message + ")";
    }
  }

  setInterval(() => { if ($("adv-auto").checked) poll(); }, 1000);
  $("adv-refresh").addEventListener("click", () => { ADV.lastUpdatedAt = 0; ADV.lastSearchKey = ""; ADV.demo = false; poll(); });
  $("adv-seat").addEventListener("change", () => { ADV.lastSearchKey = ""; renderState(); runSearch(); });
  $("adv-beam").addEventListener("change", () => { ADV.lastSearchKey = ""; runSearch(); });

  /* ---------- 示範模式: 不需橋接器,生成中局盤面展示功能 ---------- */
  $("adv-demo").addEventListener("click", () => {
    ADV.demo = true;
    // 跑半場對局取中局狀態
    const seed = Math.floor(Math.random() * 1e6);
    const st = E.createState(AI.DECKS.blueControl.cards, AI.DECKS.redWhiteAggro.cards, seed, { maxTurns: 80 });
    st.deckOf = { player1: "blueControl", player2: "redWhiteAggro" };
    st.deckLists = { player1: AI.DECKS.blueControl.cards.slice(), player2: AI.DECKS.redWhiteAggro.cards.slice() };
    for (let i = 0; i < 5 && !st.winner; i++) {
      AI.aiTakeTurn(st, E.currentPlayer(st));
      if (!st.winner) E.endTurn(st);
    }
    st.log.length = 0;
    ADV.st = st;
    ADV.meta = { lastEvents: ["(示範模式: 隨機中局盤面,seed " + seed + ")"], actionCount: "-", corrections: 0 };
    $("adv-status").textContent = "示範模式 (未連接橋接器)";
    $("adv-seat").value = E.currentPlayer(st);
    renderState();
    ADV.lastSearchKey = "";
    runSearch();
  });
})();
