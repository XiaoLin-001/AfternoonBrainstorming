/* 午後激盪 對戰模式 — 人類 (或外部 AI 代打) vs 引擎 AI */
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
  const cardZh = (n) => `${COLOR_ZH[E.colorOf(n)] || ""}${JOB_ZH[E.jobOf(n)] || n}`;

  /* ---------- 卡池 (已實作單位) ---------- */
  const FACTIONS = [
    ["白色", ["ADCW", "APW", "TANKW", "HFW", "LFW", "ASSW", "APTW", "SPW"]],
    ["紅色", ["ADCR", "APR", "TANKR", "HFR", "LFR", "ASSR", "APTR", "SPR"]],
    ["藍色", ["ADCB", "APB", "TANKB", "HFB", "LFB", "ASSB", "APTB", "SPB"]],
    ["墨綠", ["ADCDKG", "APDKG", "TANKDKG", "HFDKG", "LFDKG", "ASSDKG", "APTDKG", "SPDKG"]],
    ["橘色", ["ADCO", "APO", "TANKO", "HFO", "LFO", "ASSO", "APTO", "SPO"]],
    ["綠色", ["ADCG", "APG", "TANKG", "HFG", "LFG", "ASSG", "APTG", "SPG"]],
    ["紫色", ["APP", "TANKP", "HFP", "ASSP"]],
  ];
  // 引擎掛勾未覆蓋的卡不開放 (誠實卡池)
  const IMPLEMENTED = new Set([
    "ADCW","APW","TANKW","HFW","LFW","ASSW","APTW","SPW",
    "ADCR","APR","TANKR","HFR","LFR","ASSR","APTR","SPR",
    "ADCB","APB","TANKB","HFB","LFB","ASSB","APTB","SPB",
    "ADCDKG","APDKG","TANKDKG","HFDKG","LFDKG","ASSDKG","APTDKG","SPDKG",
    "ADCO","APO","TANKO","HFO","LFO","ASSO","APTO","SPO",
    "ADCG","APG","TANKG","HFG","LFG","ASSG","APTG","SPG",
    "APP","TANKP","HFP","ASSP",
  ]);

  /* ---------- 套牌構築狀態 ---------- */
  const build = { mine: [], opp: [] };

  function renderBuilder(side) {
    const deck = build[side];
    const poolEl = $(side === "mine" ? "vs-pool-mine" : "vs-pool-opp");
    const deckEl = $(side === "mine" ? "vs-deck-mine" : "vs-deck-opp");
    const cntEl = $(side === "mine" ? "vs-cnt-mine" : "vs-cnt-opp");
    cntEl.textContent = `${deck.length}/12`;
    cntEl.style.color = deck.length === 12 ? "#7dde8b" : "var(--accent)";

    poolEl.innerHTML = "";
    for (const [fname, cards] of FACTIONS) {
      const head = document.createElement("div");
      head.className = "pool-faction";
      head.textContent = fname;
      poolEl.appendChild(head);
      const row = document.createElement("div");
      row.className = "pool-row";
      for (const n of cards) {
        if (!IMPLEMENTED.has(n)) continue;
        const cnt = deck.filter(c => c === n).length;
        const stat = E.STATS[n];
        const chip = document.createElement("div");
        chip.className = "pool-chip" + ((cnt >= 2 || deck.length >= 12) ? " maxed" : "");
        chip.title = `${n} ${stat.hp}/${stat.dmg}`;
        chip.innerHTML = `<span style="color:${COLOR_CSS[E.colorOf(n)]}">${JOB_GLYPH[E.jobOf(n)]}</span>` +
                         `${JOB_ZH[E.jobOf(n)]} <span style="color:#666">${stat.hp}/${stat.dmg}</span>` +
                         (cnt ? `<span class="cnt">×${cnt}</span>` : "");
        chip.addEventListener("click", () => {
          if (deck.length >= 12 || deck.filter(c => c === n).length >= 2) return;
          deck.push(n);
          renderBuilder(side);
        });
        row.appendChild(chip);
      }
      poolEl.appendChild(row);
    }

    deckEl.innerHTML = deck.length ? "" : "<span style='color:#555;font-size:12px'>(點上方卡池加入)</span>";
    deck.forEach((n, i) => {
      const slot = document.createElement("div");
      slot.className = "deck-slot";
      slot.innerHTML = `<span style="color:${COLOR_CSS[E.colorOf(n)]}">${JOB_GLYPH[E.jobOf(n)]}</span> ${cardZh(n)}`;
      slot.title = "點擊移除";
      slot.addEventListener("click", () => { deck.splice(i, 1); renderBuilder(side); });
      deckEl.appendChild(slot);
    });
  }

  function fillPresetSelect(sel) {
    sel.innerHTML = "<option value=''>—</option>";
    for (const id in DECKS) {
      const o = document.createElement("option");
      o.value = id; o.textContent = DECKS[id].label;
      sel.appendChild(o);
    }
  }
  fillPresetSelect($("vs-preset-mine"));
  fillPresetSelect($("vs-preset-opp"));
  $("vs-preset-mine").addEventListener("change", e => { if (e.target.value) { build.mine = DECKS[e.target.value].cards.slice(); renderBuilder("mine"); } });
  $("vs-preset-opp").addEventListener("change", e => { if (e.target.value) { build.opp = DECKS[e.target.value].cards.slice(); renderBuilder("opp"); } });
  $("vs-clear-mine").addEventListener("click", () => { build.mine = []; $("vs-preset-mine").value = ""; renderBuilder("mine"); });
  $("vs-clear-opp").addEventListener("click", () => { build.opp = []; $("vs-preset-opp").value = ""; renderBuilder("opp"); });
  // 預設載入:我方藍紫、對方紅白
  build.mine = DECKS.blueControl.cards.slice();
  build.opp = DECKS.redWhiteAggro.cards.slice();
  $("vs-preset-mine").value = "blueControl";
  $("vs-preset-opp").value = "redWhiteAggro";
  renderBuilder("mine");
  renderBuilder("opp");

  /* ---------- 對局狀態 ---------- */
  const VS = {
    st: null, mySeat: "player1", aiSeat: "player2", selected: -1, over: false, logBuf: [],
    mode: "attack",        // attack | move (點自己單位時的行為)
    moverUid: null,        // 已選定的待移動單位
    oppCtl: "sim",         // 對方AI: sim=模擬器AI, camp=戰役AI
    campBuffs: false,
  };

  function matchPreset(deck) {
    const sorted = deck.slice().sort().join(",");
    for (const id in DECKS) {
      if (DECKS[id].cards.slice().sort().join(",") === sorted) return id;
    }
    return "custom";
  }

  function startGame() {
    if (build.mine.length !== 12 || build.opp.length !== 12) {
      $("vs-setup-msg").textContent = "雙方套牌都必須恰好 12 張!";
      return;
    }
    $("vs-setup-msg").textContent = "";
    VS.mySeat = $("vs-seat").value;
    VS.aiSeat = E.opponentOf(VS.mySeat);
    VS.oppCtl = $("vs-oppai").value;
    VS.campBuffs = $("vs-buffs").checked;
    VS.mode = "attack";
    VS.moverUid = null;
    let seed = parseInt($("vs-seed").value || "0", 10);
    if (!seed) { seed = Math.floor(Math.random() * 1e6); $("vs-seed").value = seed; }

    const deck1 = VS.mySeat === "player1" ? build.mine : build.opp;
    const deck2 = VS.mySeat === "player1" ? build.opp : build.mine;
    const st = E.createState(deck1, deck2, seed, { record: false, maxTurns: 80 });
    st.deckOf = {
      player1: VS.mySeat === "player1" ? "human" : matchPreset(build.opp),
      player2: VS.mySeat === "player2" ? "human" : matchPreset(build.opp),
    };
    st.deckLists = { player1: deck1.slice(), player2: deck2.slice() };
    VS.st = st;
    VS.selected = -1;
    VS.over = false;
    VS.logBuf = [`對戰開始 (seed ${seed}),你是 ${E.zh(VS.mySeat)},引擎 AI 是 ${E.zh(VS.aiSeat)}。`];

    $("vs-setup").style.display = "none";
    $("vs-play").style.display = "block";
    $("vs-banner").style.display = "none";
    $("vs-export-wrap").style.display = "none";
    $("vs-n1").textContent = "玩家1・" + (VS.mySeat === "player1" ? "你" : "引擎AI");
    $("vs-n2").textContent = "玩家2・" + (VS.mySeat === "player2" ? "你" : "引擎AI");

    buildBoard();
    // AI 先手的話,先讓它走
    if (E.currentPlayer(st) === VS.aiSeat) aiMove();
    render();
  }

  function buildBoard() {
    const board = $("vs-board");
    board.innerHTML = "";
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.id = `vcell-${x}-${y}`;
      cell.addEventListener("click", () => onCellClick(x, y));
      board.appendChild(cell);
    }
  }

  function drainLog() {
    if (!VS.st) return;
    for (const l of VS.st.log.splice(0)) VS.logBuf.push(l);
    if (VS.logBuf.length > 400) VS.logBuf.splice(0, VS.logBuf.length - 400);
  }

  function finishCheck() {
    const st = VS.st;
    if (!st.winner) return;
    VS.over = true;
    const youWon = st.winner === VS.mySeat;
    const msg = st.winner === "tie" ? "平手!" : (youWon ? "🎉 你獲勝了!" : "💀 引擎 AI 獲勝。");
    $("vs-banner").textContent = `${msg} 終分 ${st.score} (${E.zh(st.winner)})`;
    $("vs-banner").style.display = "block";
  }

  function aiMove() {
    const st = VS.st;
    if (st.winner) return;
    if (VS.oppCtl === "camp") {
      const CAMP = window.AB.ABCampaign;
      const presetId = matchPreset(st.deckLists[VS.aiSeat]);
      const stage = (DECKS[presetId] && DECKS[presetId].stage) || CAMP.stageForDeck(st.deckLists[VS.aiSeat]);
      CAMP.takeTurn(st, VS.aiSeat, stage, { buffs: VS.campBuffs });
    } else {
      AI.aiTakeTurn(st, VS.aiSeat);
    }
    if (!st.winner) E.endTurn(st);
    drainLog();
    finishCheck();
  }

  /* ---------- 人類操作 ---------- */
  function myTurn() {
    return VS.st && !VS.over && E.currentPlayer(VS.st) === VS.mySeat;
  }

  function myMovers() {
    return E.alive(VS.st.players[VS.mySeat].onBoard).filter(c => c.moving);
  }

  function onCellClick(x, y) {
    if (!myTurn()) return;
    const st = VS.st;
    // 1) 放置手牌
    if (VS.selected >= 0) {
      const name = st.players[VS.mySeat].hand[VS.selected];
      if (E.playCard(st, VS.mySeat, VS.selected, x, y)) {
        VS.selected = -1;
      } else {
        VS.logBuf.push(`(無法放置 ${name} 於 (${x},${y}) — 格子被佔用)`);
      }
      drainLog(); render();
      return;
    }
    const unit = E.alive(st.players[VS.mySeat].onBoard).find(c => c.x === x && c.y === y);
    const movers = myMovers();

    // 2) 點空格 → 若有待移動單位,移動過去
    if (!unit && !E.cellOccupied(st, x, y) && movers.length) {
      const active = movers.find(m => m.uid === VS.moverUid) || (movers.length === 1 ? movers[0] : null);
      if (active) {
        if (E.moveCard(st, active, x, y)) VS.moverUid = null;
        else VS.logBuf.push("(只能移動到相鄰的空格)");
      } else {
        VS.logBuf.push("(有多個待移動單位,先點選要移動的那一個)");
      }
      drainLog(); render();
      return;
    }
    if (!unit) return;

    // 3) 點自己的待移動單位 → 選定它
    if (unit.moving) {
      VS.moverUid = unit.uid;
      VS.logBuf.push(`(已選定 ${unit.name},點相鄰空格移動)`);
      render();
      return;
    }
    // 4) 移動模式: 消耗移動點讓單位進入移動狀態
    if (VS.mode === "move") {
      if (st.movings[VS.mySeat] <= 0) { VS.logBuf.push("(沒有可用移動點 — 先使用 MOVEO)"); render(); return; }
      if (unit.numbness) { VS.logBuf.push(`(${unit.name} 麻痺中,無法移動)`); render(); return; }
      if (E.spendMoving(st, VS.mySeat, unit)) {
        VS.moverUid = unit.uid;
        VS.logBuf.push(`(${unit.name} 準備移動,點相鄰空格)`);
      }
      drainLog(); render();
      return;
    }
    // 5) 攻擊模式: 出刀
    if (st.attacks[VS.mySeat] <= 0) { VS.logBuf.push("(刀數不足)"); render(); return; }
    if (unit.numbness) { VS.logBuf.push(`(${unit.name} 處於麻痺,無法攻擊)`); render(); return; }
    const ok = E.attackWith(st, VS.mySeat, unit);
    if (!ok) VS.logBuf.push(`(${unit.name} 攻擊範圍內沒有目標)`);
    drainLog(); render();
  }

  $("vs-endturn").addEventListener("click", () => {
    if (!myTurn()) return;
    VS.selected = -1;
    VS.moverUid = null;
    E.endTurn(VS.st);
    drainLog();
    finishCheck();
    if (!VS.over) aiMove();
    render();
  });

  $("vs-mode-att").addEventListener("click", () => { VS.mode = "attack"; render(); });
  $("vs-mode-move").addEventListener("click", () => { VS.mode = "move"; render(); });

  $("vs-restart").addEventListener("click", () => {
    $("vs-play").style.display = "none";
    $("vs-setup").style.display = "block";
    VS.st = null;
  });

  $("vs-start").addEventListener("click", startGame);

  /* ---------- 匯出局面 (給外部 AI) ---------- */
  function exportState() {
    const st = VS.st;
    if (!st) return "";
    const me = VS.mySeat, opp = VS.aiSeat;
    const L = [];
    L.push(`=== 午後激盪 局面 (第 ${Math.floor(st.turnNumber / 2) + 1} 輪,輪到 ${E.zh(E.currentPlayer(st))}) ===`);
    L.push(`分數: ${st.score} (負=玩家1領先,正=玩家2領先;差10分獲勝)`);
    L.push(`你是 ${E.zh(me)}。你的刀數 ${st.attacks[me]},對方刀數 ${st.attacks[opp]}`);
    L.push(`藍球 你${st.tokens[me]}/對${st.tokens[opp]} | 圖騰 你${st.totem[me]}/對${st.totem[opp]} | 運氣 你${st.luck[me]}%/對${st.luck[opp]}% | 移動點 你${st.movings[me]}/對${st.movings[opp]}`);
    L.push("");
    L.push("棋盤 4x4 (x,y 從0起,左上=(0,0)):");
    for (const c of E.allCards(st).filter(c => c.hp > 0)) {
      const side = c.owner === me ? "我方" : c.owner === opp ? "敵方" : "中立";
      L.push(`  ${side} ${c.name}(${cardZh(c.name)}) @(${c.x},${c.y}) 血${c.hp}/${c.maxHp} 攻${c.dmg}${c.armor ? " 甲" + c.armor : ""}${c.numbness ? " [麻痺]" : ""} 攻擊模式:${c.attackTypes}`);
    }
    L.push("");
    const meP = st.players[me], opP = st.players[opp];
    L.push(`我方手牌: ${meP.hand.map((n, i) => `[${i}]${n}(${cardZh(n)})`).join(" ") || "(無)"}`);
    L.push(`敵方手牌(互見): ${opP.hand.map(n => `${n}(${cardZh(n)})`).join(" ") || "(無)"}`);
    L.push(`我方 牌庫${meP.drawPile.length} 棄牌[${meP.discard.join(",")}]`);
    L.push(`敵方 牌庫${opP.drawPile.length} 棄牌[${opP.discard.join(",")}]`);
    L.push("");
    L.push("我方可行動作:");
    const empty = [];
    for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) if (!E.cellOccupied(st, xx, yy)) empty.push(`(${xx},${yy})`);
    L.push(`  放置: 任一手牌到空格 ${empty.join(" ")}`);
    const attackers = E.alive(meP.onBoard).filter(c => !c.numbness && c.attackTypes && c.name !== "APTG" &&
      E.detectionCandidates(c, c.attackTypes, E.alive(E.sideCards(st, me, true))).length);
    L.push(`  出刀(剩${st.attacks[me]}): ${attackers.map(c => `${c.name}@(${c.x},${c.y})`).join(" ") || "(無有效攻擊)"}`);
    const movers = E.alive(meP.onBoard).filter(c => c.moving);
    if (movers.length) L.push(`  待移動單位(點相鄰空格): ${movers.map(c => `${c.name}@(${c.x},${c.y})`).join(" ")}`);
    if (st.movings[me] > 0) L.push(`  可用移動點 ${st.movings[me]} (移動模式下點自己單位啟動)`);
    if (meP.hand.includes("MOVEO")) L.push("  可使用 MOVEO (+1 移動點,本回合限定)");
    L.push("  結束回合");
    L.push("");
    L.push("規則提醒: 單位進場麻痺(刺客除外),麻痺單位本回合結算不得分且不能攻擊;結算時每個未麻痺單位+1分(白寶石+2)。");
    return L.join("\n");
  }

  $("vs-export-btn").addEventListener("click", () => {
    const txt = exportState();
    const wrap = $("vs-export-wrap");
    const ta = $("vs-export");
    wrap.style.display = wrap.style.display === "block" ? "none" : "block";
    if (wrap.style.display === "block") {
      ta.value = txt;
      ta.focus(); ta.select();
      if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
    }
  });

  /* ---------- 渲染 ---------- */
  function renderRes(p, dId, rId, hId) {
    const st = VS.st;
    const who = p === VS.mySeat ? "你" : "引擎AI";
    const deckLabel = matchPreset(st.deckLists[p]);
    $(dId).textContent = `${E.zh(p)}・${who}${deckLabel !== "custom" && DECKS[deckLabel] ? "・" + DECKS[deckLabel].short : "・自訂套牌"}`;
    const extra = [];
    const deckL = st.deckLists[p];
    if (deckL.some(n => E.colorOf(n) === "Blue")) extra.push(`藍球 <b>${st.tokens[p]}</b>`);
    if (deckL.some(n => E.colorOf(n) === "DarkGreen")) extra.push(`圖騰 <b>${st.totem[p]}</b>`);
    if (deckL.some(n => E.colorOf(n) === "Green")) extra.push(`運氣 <b>${st.luck[p]}%</b>`);
    if (deckL.some(n => E.colorOf(n) === "Orange") || st.movings[p] > 0) extra.push(`移動點 <b>${st.movings[p]}</b>`);
    const pl = st.players[p];
    $(rId).innerHTML =
      `刀數 <b>${st.attacks[p]}</b>　手牌 <b>${pl.hand.length}</b>　牌庫 <b>${pl.drawPile.length}</b>　棄牌 <b>${pl.discard.length}</b>` +
      (extra.length ? "　" + extra.join("　") : "");
    $(hId).textContent = "手牌: " + (pl.hand.length ? pl.hand.map(cardZh).join("、") : "(無)");
  }

  function render() {
    const st = VS.st;
    if (!st) return;
    // 棋盤
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const cell = $(`vcell-${x}-${y}`);
      cell.innerHTML = "";
      cell.classList.toggle("placeable", myTurn() && VS.selected >= 0 && !E.cellOccupied(st, x, y));
    }
    for (const u of E.allCards(st).filter(c => c.hp > 0)) {
      const cell = $(`vcell-${u.x}-${u.y}`);
      if (!cell) continue;
      const div = document.createElement("div");
      const clickable = myTurn() && VS.selected < 0 && u.owner === VS.mySeat && !u.numbness;
      div.className = "unit " + (u.owner === "player1" ? "p1" : u.owner === "player2" ? "p2" : "neutral") +
                      (u.numbness ? " numb" : "") + (clickable ? " clickable" : "");
      const col = COLOR_CSS[u.color] || "#ccc";
      const movingBadge = u.moving ? `<div style="position:absolute;bottom:2px;right:4px;font-size:11px;color:var(--accent)">➤${VS.moverUid === u.uid ? "✓" : ""}</div>` : "";
      div.innerHTML =
        `<div class="glyph" style="color:${col}">${JOB_GLYPH[u.job] || "?"}</div>` +
        `<div class="uname">${cardZh(u.name)}</div>` +
        `<div class="stats">${u.hp}/${u.dmg + u.extraDamage}</div>` +
        (u.armor > 0 ? `<div class="armor">🛡${u.armor}</div>` : "") +
        (u.numbness ? `<div class="zz">💤</div>` : "") + movingBadge;
      div.title = `${u.name} 攻擊模式:${u.attackTypes || "無"}` + (u.moving ? " [待移動]" : "");
      cell.appendChild(div);
    }
    // 分數
    const s = Math.max(-10, Math.min(10, st.score));
    $("vs-needle").style.left = `calc(${50 + s * 5}% - 2px)`;
    const lead = st.score === 0 ? "持平" : (st.score < 0 ? `玩家1 領先 ${-st.score}` : `玩家2 領先 ${st.score}`);
    $("vs-scoreval").textContent = `${lead} (差 10 分獲勝)`;
    $("vs-turninfo").textContent = `第 ${Math.floor(st.turnNumber / 2) + 1} 輪・${myTurn() ? "你的回合" : (VS.over ? "對局結束" : "AI 回合")}`;
    // 資源
    renderRes("player1", "vs-rd1", "vs-rp1", "vs-rh1");
    renderRes("player2", "vs-rd2", "vs-rp2", "vs-rh2");
    // 我的手牌
    const handEl = $("vs-hand");
    handEl.innerHTML = "";
    st.players[VS.mySeat].hand.forEach((n, i) => {
      const stt = E.STATS[n] || { hp: 0, dmg: 0 };
      const div = document.createElement("div");
      div.className = "handcard" + (VS.selected === i ? " sel" : "");
      div.innerHTML = `<span style="color:${COLOR_CSS[E.colorOf(n)]}">${JOB_GLYPH[E.jobOf(n)]}</span> ${cardZh(n)}` +
                      `<div class="hstats">${n === "MOVEO" ? "點擊使用" : stt.hp + "/" + stt.dmg}</div>`;
      div.addEventListener("click", () => {
        if (!myTurn()) return;
        if (n === "MOVEO") {           // 魔法牌: 點擊直接使用 (+1 移動點)
          E.playCard(st, VS.mySeat, i, 0, 0);
          VS.selected = -1;
          drainLog(); render();
          return;
        }
        VS.selected = VS.selected === i ? -1 : i;
        render();
      });
      handEl.appendChild(div);
    });
    // 按鈕狀態
    $("vs-endturn").disabled = !myTurn();
    $("vs-mode-att").classList.toggle("ghost", VS.mode !== "attack");
    $("vs-mode-move").classList.toggle("ghost", VS.mode !== "move");
    // 戰報
    const logEl = $("vs-log");
    logEl.innerHTML = VS.logBuf.map(l => {
      let cls = "";
      if (l.includes("斬殺") || l.includes("死亡")) cls = "kill";
      if (l.startsWith("——") || l.includes("回合結束")) cls = "hl";
      if (l.includes("★") || l.includes("獲勝")) cls = "star";
      return `<span class="${cls}">${l}</span>`;
    }).join("\n");
    logEl.scrollTop = logEl.scrollHeight;
    // 匯出框若開著就即時更新
    if ($("vs-export-wrap").style.display === "block") $("vs-export").value = exportState();
  }
})();
