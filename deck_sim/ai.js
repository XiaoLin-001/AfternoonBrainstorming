/* =====================================================================
 * 午後激盪 套牌定義 + 流派 AI (v3)
 *
 * v3 對戰思維 (在 v2 一步模擬基礎上):
 *  1. 讀對方手牌 — 遊戲規則雙方手牌互見:敵方手握刺客時,
 *     脆皮單位迴避斜角敞開的格子;手握 SPB 時預期轟炸。
 *  2. 記牌 — 流派牌表已知,扣掉 (手牌+棄牌+場上) 即得對方牌庫剩餘,
 *     據此估計刺客等關鍵牌下回合被抽出的機率,調整佈防強度。
 *  3. 敵方輸出投影 — 依對方刀數與每個單位的攻擊模式,計算
 *     「對手下回合最多能對我造成什麼」,直接納入盤面評估:
 *     麻痺對方主攻手 = 同時否定其得分與其下回合輸出,AI 自然學會控場。
 *  4. 放置也走真引擎模擬 — 候選格子逐一複製棋局實際放置
 *     (進場效果如 SPB 轟炸、LFDKG 進場傷害如實發生) 後比較盤面。
 *  5. 角色價值表 — 引擎/核心單位 (APR、APDKG、SPR...) 的擊殺優先度
 *     高於白板單位,評估函數依名直接加權。
 * ===================================================================== */
(function (root) {
  "use strict";
  const E = (typeof module !== "undefined") ? require("./engine.js").ABEngine
                                            : window.AB.ABEngine;
  const CAMP = (typeof module !== "undefined") ? require("./campaign_ai.js").ABCampaign
                                               : window.AB.ABCampaign;

  const DECKS = {
    blueControl: {
      id: "blueControl",
      label: "藍紫中速控制",
      short: "藍紫控制",
      cards: ["APB", "APB", "TANKB", "TANKB", "ADCB", "ADCB",
              "ASSB", "ASSB", "SPB", "SPB", "HFP", "HFP"],
      desc: "藍球引擎+麻痺鎖+SPB清場,HFP補刀數。前期穩守,中期一波清場後滾分。",
    },
    redWhiteAggro: {
      id: "redWhiteAggro",
      label: "紅白快攻",
      short: "紅白快攻",
      cards: ["TANKW", "TANKW", "TANKR", "TANKR", "HFW", "HFW",
              "LFR", "LFR", "APR", "APR", "ADCW", "ADCW"],
      desc: "抽到就丟的 8+4 鋪場壓制,APR 偷攻擊,靠人數差搶 10 分。",
    },
    darkGreenTotem: {
      id: "darkGreenTotem",
      label: "墨綠圖騰",
      short: "墨綠圖騰",
      cards: ["APDKG", "APDKG", "TANKDKG", "TANKDKG", "ADCDKG", "ADCDKG",
              "APTDKG", "APTDKG", "LFDKG", "LFDKG", "SPDKG", "SPDKG"],
      desc: "刻印滾雪球:APDKG 每刀+5 刻印,SPDKG 翻倍,APTDKG 後期一刀超大傷害。",
    },
  };

  /* 戰役套牌 (使用者 campaign/ai_decks.py) — 預設由戰役 AI 操控 */
  for (const stage of ["white", "red", "blue", "green", "orange", "boss"]) {
    DECKS["camp_" + stage] = {
      id: "camp_" + stage,
      label: CAMP.STAGE_LABELS[stage],
      short: CAMP.STAGE_LABELS[stage].replace("戰役·", "戰役"),
      cards: CAMP.STAGE_AI_DECKS[stage].slice(),
      desc: "戰役模式 " + stage + " 關卡的 AI 套牌 (campaign/ai_decks.py)",
      stage,
      defaultController: "camp",
    };
  }

  /* 角色戰略價值 (擊殺/保護優先度的名單加權) */
  const ROLE_VALUE = {
    APR: 2.6, SPR: 2.2, APDKG: 2.4, SPDKG: 2.4, APTDKG: 2.0,
    APB: 2.0, ADCB: 1.8, HFP: 1.8, ADCW: 1.6, LFR: 1.4,
    ADCDKG: 1.5, HFB: 1.4, LFB: 1.3, SPB: 1.0, ASSB: 1.2,
  };
  function roleValue(name) { return ROLE_VALUE[name] || 1.0; }

  /* =====================================================================
   * 對手情報 (手牌互見 + 記牌)
   * =================================================================== */
  function opponentInfo(st, owner) {
    const opp = E.opponentOf(owner);
    const oppPl = st.players[opp];
    const info = {
      assInHand: 0, assMaxDmg: 0, assDrawChance: 0,
      spbInHand: 0, spbPings: 0,
      knivesNextTurn: st.attacks[opp] + 1,
    };
    for (const n of oppPl.hand) {
      if (E.jobOf(n) === "ASS") { info.assInHand++; info.assMaxDmg = Math.max(info.assMaxDmg, E.STATS[n].dmg); }
      if (n === "SPB") info.spbInHand++;
    }
    if (info.spbInHand) info.spbPings = oppPl.onBoard.length + oppPl.discard.length;
    // 記牌:流派牌表 − (手牌+棄牌+場上) = 牌庫剩餘 → 刺客抽出機率
    const deckList = (st.deckLists && st.deckLists[opp]) ||
                     (st.deckOf && DECKS[st.deckOf[opp]] ? DECKS[st.deckOf[opp]].cards : null);
    if (deckList) {
      const seen = oppPl.hand.concat(oppPl.discard, oppPl.onBoard.map(c => c.name));
      const remaining = deckList.slice();
      for (const s of seen) {
        const i = remaining.indexOf(s);
        if (i >= 0) remaining.splice(i, 1);
      }
      const assLeft = remaining.filter(n => E.jobOf(n) === "ASS").length;
      info.assDrawChance = remaining.length ? assLeft / remaining.length : 0;
      if (assLeft) info.assMaxDmg = Math.max(info.assMaxDmg, ...remaining.filter(n => E.jobOf(n) === "ASS").map(n => E.STATS[n].dmg));
    }
    return info;
  }

  /* =====================================================================
   * 局勢判讀
   * =================================================================== */
  function settlePotential(cards) {
    let pts = 0;
    for (const c of cards) {
      if (c.numbness || c.hp <= 0) continue;
      pts += (c.name === "SPW" ? 2 : 1);
    }
    return pts;
  }

  function turnContext(st, owner) {
    const opp = E.opponentOf(owner);
    const myLead = owner === "player1" ? -st.score : st.score;
    const mine = E.alive(st.players[owner].onBoard);
    const theirs = E.alive(st.players[opp].onBoard);
    const mySettleNow = settlePotential(mine);
    const enemyNextSettle = settlePotential(theirs);
    const leadAfterMySettle = myLead + mySettleNow;
    const canWinNow = leadAfterMySettle >= 10;
    const enemyLethal = !canWinNow && (-leadAfterMySettle + enemyNextSettle >= 10);
    const enemyNearLethal = !canWinNow && (-leadAfterMySettle + enemyNextSettle >= 8);
    return {
      round: Math.floor(st.turnNumber / 2) + 1,
      myLead, mySettleNow, leadAfterMySettle, enemyNextSettle,
      canWinNow, enemyLethal, enemyNearLethal,
      behind: myLead < 0,
      boardGap: theirs.length - mine.length,
      mine, theirs,
      oppInfo: opponentInfo(st, owner),
    };
  }

  /* =====================================================================
   * 敵方輸出投影:對手下回合最多能對我造成的傷害/控制
   *  - 只計未麻痺的敵方單位 (麻痺者下回合不能出手)
   *  - 取對方刀數上限內價值最高的幾刀
   * =================================================================== */
  function effDamage(st, u) {
    let d = u.dmg + u.extraDamage;
    if (u.name === "HFB") d = u.dmg + st.tokens[u.owner];
    if (u.name === "ADCDKG") d = u.dmg + Math.floor(st.totem[u.owner] / 4);
    if (u.name === "APTDKG") d = u.dmg + Math.floor(st.totem[u.owner] / 2);
    return d;
  }

  function enemyThreat(st, owner) {
    const opp = E.opponentOf(owner);
    const mine = E.alive(st.players[owner].onBoard);
    const attackers = E.alive(st.players[opp].onBoard).filter(u => !u.numbness && u.attackTypes);
    let total = 0;
    const knives = st.attacks[opp] + 1;
    if (mine.length && attackers.length) {
      const hitValues = [];
      for (const u of attackers) {
        const eff = effDamage(st, u);
        const cand = E.detectionCandidates(u, u.attackTypes, mine);
        if (!cand.length) continue;
        let v = 0;
        const scoreTarget = (t) => {
          let tv = Math.min(eff, t.hp + t.armor) * 0.9;
          if (t.hp + t.armor <= eff) tv += 2.5 * roleValue(t.name);     // 我方單位被斬殺
          if (["APR", "APB", "APW", "APDKG", "APP"].includes(u.name)) { // 麻痺/偷取威脅
            tv += 2.0 + (u.name === "APR" ? t.dmg * 1.2 : 0);
          }
          return tv;
        };
        for (const c of cand) {
          if (c.group) { let s = 0; for (const t of c.group) s += scoreTarget(t); v += s / c.group.length; }
          else v += scoreTarget(c);
        }
        hitValues.push(v);
      }
      hitValues.sort((a, b) => b - a);
      for (let i = 0; i < Math.min(knives, hitValues.length); i++) total += hitValues[i] * (i === 0 ? 1 : 0.8);
    }
    // 進場斬殺威脅: 對手手牌的刺客 (互見) 可跳進我方脆皮的空斜角格直接處決
    if (mine.length) {
      const info = opponentInfo(st, owner);
      const factor = info.assInHand > 0 ? 1.0 : (info.assDrawChance > 0.2 ? info.assDrawChance * 0.7 : 0);
      if (factor > 0 && info.assMaxDmg > 0) {
        const exposures = [];
        for (const m of mine) {
          if (m.hp + m.armor > info.assMaxDmg) continue;   // 一刀殺不死,不算進場威脅
          let openDiag = 0;
          for (const [dx, dy] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
            const nx = m.x + dx, ny = m.y + dy;
            if (E.validPos(nx, ny) && !E.cellOccupied(st, nx, ny)) openDiag++;
          }
          if (openDiag > 0) exposures.push(3.2 * roleValue(m.name) * Math.min(openDiag, 2) / 2);
        }
        exposures.sort((a, b) => b - a);
        const slots = Math.max(1, Math.min(2, info.assInHand || 1));
        for (let i = 0; i < Math.min(slots, exposures.length); i++) total += exposures[i] * factor;
      }
    }
    return total;
  }

  /* 手牌持有價值: 刺客在手是懸頂之劍 (對手必須繞著走),倒光手牌 ≠ 賺 */
  const HOLD_VALUE = { ASS: 2.5, SP: 0.9, ADC: 0.5, AP: 0.45, APT: 0.3, HF: 0.3, LF: 0.3, TANK: 0.2 };
  function handHoldValue(st, owner) {
    let v = 0;
    for (const n of st.players[owner].hand) {
      v += HOLD_VALUE[E.jobOf(n)] || 0.15;
    }
    return v;
  }

  /* 保鏢檢查: 場上有脆皮輸出卻沒有前排 (hp>5) = 餵斬殺 */
  function protectionTerm(st, owner) {
    const mine = E.alive(st.players[owner].onBoard);
    const hasFront = mine.some(c => c.hp + c.armor > 5);
    if (hasFront) return 0;
    const squishies = mine.filter(c => ["ADC", "AP", "SP"].includes(E.jobOf(c.name))).length;
    return -squishies * 1.5;
  }

  /* =====================================================================
   * 盤面評估
   * =================================================================== */
  function evalPosition(st, owner, w) {
    const opp = E.opponentOf(owner);
    const lead = owner === "player1" ? -st.score : st.score;
    const mine = E.alive(st.players[owner].onBoard);
    const theirs = E.alive(st.players[opp].onBoard);
    let v = lead * w.lead;
    v += settlePotential(mine) * w.mySettle;
    v -= settlePotential(theirs) * w.theirSettle;
    for (const c of mine) v += ((c.hp + c.armor) * 0.20 + (c.dmg + c.extraDamage) * 0.40) * roleValue(c.name) * 0.7;
    for (const c of theirs) v -= ((c.hp + c.armor) * 0.26 + (c.dmg + c.extraDamage) * 0.55) * roleValue(c.name);
    v += st.tokens[owner] * 0.30 + st.totem[owner] * 0.12;
    v -= st.tokens[opp] * 0.30 + st.totem[opp] * 0.12;       // 打坦餵資源的代價
    v += handHoldValue(st, owner);                           // 手牌持有價值 (倒光手牌≠賺)
    v += protectionTerm(st, owner);                          // 保鏢檢查 (脆皮無前排=餵刀)
    v -= enemyThreat(st, owner) * w.threat;                  // 對手下回合輸出投影 (含進場斬殺)
    return v;
  }

  const W_NORMAL = { lead: 3.0, mySettle: 1.6, theirSettle: 2.0, threat: 0.40 };
  const W_DENY   = { lead: 3.0, mySettle: 1.2, theirSettle: 6.0, threat: 0.55 };

  /* =====================================================================
   * 出刀:一步模擬挑最優解
   * =================================================================== */
  function chooseAttacks(st, owner, ctx, opts) {
    opts = opts || {};
    const w = (ctx.enemyLethal || ctx.enemyNearLethal) ? W_DENY : W_NORMAL;
    const desperate = ctx.enemyLethal || opts.allIn;
    const reserve = (desperate || ctx.behind || ctx.enemyNearLethal || ctx.round <= 2) ? 0 : 1;

    let guard = 0;
    while (st.attacks[owner] > 0 && guard++ < 24) {
      const base = evalPosition(st, owner, w);
      const threshold = desperate ? 0.05
                      : (st.attacks[owner] <= reserve ? 5.0 : 0.6);
      let best = null, bestDelta = threshold;
      for (const u of E.alive(st.players[owner].onBoard)) {
        if (u.numbness || !u.attackTypes) continue;
        const enemies = E.alive(E.sideCards(st, owner, true));
        if (!E.detectionCandidates(u, u.attackTypes, enemies).length) continue;
        const cl = E.cloneState(st);
        const cu = cl.players[owner].onBoard.find(c => c.uid === u.uid);
        if (!cu) continue;
        if (!E.attackWith(cl, owner, cu)) continue;
        const delta = evalPosition(cl, owner, w) - base;
        if (delta > bestDelta) { bestDelta = delta; best = u; }
      }
      if (!best) break;
      E.attackWith(st, owner, best);
      E.snapshot(st, `${E.zh(owner)} 出刀`);
      if (st.winner) return;
    }
  }

  /* =====================================================================
   * 放置:啟發式短名單 → 真引擎模擬挑格
   * =================================================================== */
  function emptyCells(st) {
    const out = [];
    for (let x = 0; x < E.W; x++) for (let y = 0; y < E.H; y++) {
      if (!E.cellOccupied(st, x, y)) out.push([x, y]);
    }
    return out;
  }
  function isCorner(x, y) { return (x === 0 || x === 3) && (y === 0 || y === 3); }
  function isCenter(x, y) { return (x === 1 || x === 2) && (y === 1 || y === 2); }

  function dangerAt(st, owner, x, y, oppInfo) {
    let danger = 0, maxHit = 0;
    const enemies = E.alive(st.players[E.opponentOf(owner)].onBoard);
    for (const u of enemies) {
      const dx = Math.abs(u.x - x), dy = Math.abs(u.y - y);
      let hit = false;
      for (const t of u.attackTypes.split(" ")) {
        if (t === "small_cross" && ((dx === 1 && dy === 0) || (dx === 0 && dy === 1))) hit = true;
        if (t === "large_cross" && (u.x === x || u.y === y) && !(dx === 0 && dy === 0)) hit = true;
        if (t === "small_x" && dx === 1 && dy === 1) hit = true;
        if (t === "nearest" && dx + dy <= 2) hit = true;  // 近似
      }
      if (hit) {
        const eff = effDamage(st, u);
        danger += eff;
        if (eff > maxHit) maxHit = eff;
      }
    }
    // 斜角敞開格 = 敵方刺客進場點;依「手牌互見+記牌」調整實際威脅
    let assSpots = 0;
    for (const [ax, ay] of [[x-1,y-1],[x+1,y-1],[x-1,y+1],[x+1,y+1]]) {
      if (E.validPos(ax, ay) && !E.cellOccupied(st, ax, ay)) assSpots++;
    }
    if (assSpots && oppInfo) {
      const assRisk = oppInfo.assInHand ? 1.0 : oppInfo.assDrawChance; // 在手=必然威脅,在庫=機率威脅
      danger += assSpots * 1.2 * assRisk;
      if (assRisk > 0 && oppInfo.assMaxDmg > maxHit) maxHit = Math.max(maxHit, oppInfo.assInHand ? oppInfo.assMaxDmg : 0);
    }
    return { danger, maxHit };
  }

  function cellHeuristic(st, owner, name, x, y, prefs, ctx) {
    const job = E.jobOf(name);
    const enemies = E.alive(st.players[E.opponentOf(owner)].onBoard);
    const fragile = prefs.fragile.includes(job);
    const myHp = E.STATS[name].hp;
    const denyMode = ctx && (ctx.enemyLethal || ctx.enemyNearLethal);
    const dg = dangerAt(st, owner, x, y, ctx && ctx.oppInfo);
    let s = -dg.danger * (fragile ? 2.0 : 0.6);
    if (fragile && dg.maxHit >= myHp) s -= 12;       // 站上去就被一刀帶走
    if (fragile && isCorner(x, y)) s += 4;
    if (job === "TANK" && !isCorner(x, y)) s += 2;
    if (name === "HFP" && isCenter(x, y)) s += 5;
    if (job === "HF" && isCenter(x, y)) s += 2;
    if (job === "ADC" && enemies.length) {
      s += enemies.filter(e => e.x === x || e.y === y).length * 1.5;
    }
    if (job === "AP" && enemies.length) {
      // 法師卡位:讓「單體最近」鎖到價值最高的敵人
      const prime = enemies.slice().sort((a, b) => (b.dmg + b.extraDamage) * roleValue(b.name) - (a.dmg + a.extraDamage) * roleValue(a.name))[0];
      s -= (Math.abs(prime.x - x) + Math.abs(prime.y - y)) * 0.9;
    }
    if (job === "ASS" && enemies.length) {
      let killable = 0;
      for (const e of enemies) {
        if (Math.abs(e.x - x) === 1 && Math.abs(e.y - y) === 1) {
          if (e.hp + e.armor <= E.STATS[name].dmg) killable += (denyMode ? 6 : 3) * roleValue(e.name);
          else killable += 0.5;
        }
      }
      s += killable * 2;
    }
    if (job === "LF" && enemies.length) {
      for (const e of enemies) {
        const dx = Math.abs(e.x - x), dy = Math.abs(e.y - y);
        if ((dx === 1 && dy === 0) || (dx === 0 && dy === 1)) s += 1.2;
      }
    }
    return s;
  }

  /* 短名單 (啟發式前 4) → cloneState 真實放置 → 評估挑最優 */
  function playTo(st, owner, name, prefs, ctx) {
    if (name === "MOVEO") return false;   // 魔法牌交由 drainMoves 處理
    const pl = st.players[owner];
    const idx = pl.hand.indexOf(name);
    if (idx < 0) return false;
    const cells = emptyCells(st);
    if (!cells.length) return false;

    const ranked = cells
      .map(([x, y]) => ({ x, y, h: cellHeuristic(st, owner, name, x, y, prefs, ctx) + (st.rng.random() - 0.5) * 0.3 }))
      .sort((a, b) => b.h - a.h)
      .slice(0, 4);

    const w = (ctx && (ctx.enemyLethal || ctx.enemyNearLethal)) ? W_DENY : W_NORMAL;
    let best = ranked[0], bestV = -1e9;
    if (ranked.length > 1 || E.jobOf(name) === "SP" || E.jobOf(name) === "ASS") {
      for (const cand of ranked) {
        const cl = E.cloneState(st);
        if (!E.playCard(cl, owner, idx, cand.x, cand.y)) continue;
        const v = evalPosition(cl, owner, w) + cand.h * 0.25; // 模擬盤面為主,佈局直覺為輔
        if (v > bestV) { bestV = v; best = cand; }
      }
    }
    if (!best) return false;
    const ok = E.playCard(st, owner, idx, best.x, best.y);
    if (ok) E.snapshot(st, `${E.zh(owner)} 放置 ${name}`);
    return ok;
  }

  /* 拚死一搏:傾倒手牌 (攻擊型優先) + 刀全花 */
  function desperationPush(st, owner, prefs, ctx, dumpOrder) {
    let guard = 0;
    let progressed = true;
    while (progressed && guard++ < 16) {
      progressed = false;
      for (const n of dumpOrder) {
        if (st.players[owner].hand.includes(n)) {
          if (playTo(st, owner, n, prefs, ctx)) { progressed = true; break; }
        }
      }
      if (st.winner) return;
    }
    guard = 0;
    while (guard++ < 12) {
      const n = st.players[owner].hand.find(c => c !== "MOVEO");
      if (!n || !playTo(st, owner, n, prefs, ctx)) break;
      if (st.winner) return;
    }
    chooseAttacks(st, owner, ctx, { allIn: true });
  }

  /* =====================================================================
   * 各流派 AI
   * =================================================================== */

  /* --- 紅白快攻 --- */
  function aggroTurn(st, owner) {
    const prefs = { fragile: ["AP", "SP", "ASS", "ADC"] };
    const ctx = turnContext(st, owner);
    if (ctx.canWinNow) { chooseAttacks(st, owner, ctx, {}); return; }

    if (ctx.enemyLethal) {
      desperationPush(st, owner, prefs, ctx,
        ["APR", "ADCW", "LFR", "HFW", "TANKR", "TANKW"]);
      return;
    }

    const order = ["TANKW", "TANKR", "HFW", "LFR", "APR", "ADCW"];
    let played = true, guard = 0;
    while (played && guard++ < 14) {
      played = false;
      for (const n of order) {
        if (st.players[owner].hand.includes(n)) {
          if (playTo(st, owner, n, prefs, ctx)) { played = true; break; }
        }
      }
      if (st.winner) return;
    }
    chooseAttacks(st, owner, ctx, { allIn: true });
  }

  /* --- 藍紫中速控制 --- */
  function blueTurn(st, owner) {
    const prefs = { fragile: ["AP", "SP", "ASS", "ADC"] };
    const ctx = turnContext(st, owner);
    const pl = st.players[owner];

    if (ctx.canWinNow) { chooseAttacks(st, owner, ctx, {}); return; }

    if (ctx.enemyLethal) {
      desperationPush(st, owner, prefs, ctx,
        ["SPB", "ASSB", "APB", "ADCB", "HFP", "TANKB"]);
      return;
    }

    const pressure = ctx.boardGap + (ctx.behind ? Math.min(-ctx.myLead / 3, 3) : 0);

    const pingCount = pl.onBoard.length + pl.discard.length;
    const enemyTotalHp = ctx.theirs.reduce((s, c) => s + c.hp + c.armor, 0);
    const haveSPB = pl.hand.includes("SPB");
    const wipeTurn = haveSPB && ctx.theirs.length >= 2 &&
                     (pingCount >= Math.max(6, enemyTotalHp * 0.55) ||
                      (ctx.round >= 4 && pingCount >= 7 && enemyTotalHp / ctx.theirs.length <= 4.5) ||
                      ctx.round >= 6);

    if (wipeTurn) {
      while (pl.hand.includes("SPB")) { if (!playTo(st, owner, "SPB", prefs, ctx)) break; if (st.winner) return; }
      while (pl.hand.includes("ASSB")) { if (!playTo(st, owner, "ASSB", prefs, ctx)) break; if (st.winner) return; }
      let guard = 0;
      while (pl.hand.length && guard++ < 12) {
        if (!playTo(st, owner, pl.hand[0], prefs, ctx)) break;
        if (st.winner) return;
      }
      chooseAttacks(st, owner, ctx, { allIn: true });
      return;
    }

    const engineOrder = ["TANKB", "HFP", "APB", "ADCB"];
    const placeLimit = pressure >= 2 ? 4 : (pressure >= 1 ? 3 : 2);
    let placed = 0, guard2 = 0;
    while (placed < placeLimit && guard2++ < 14) {
      let done = false;
      for (const n of engineOrder) {
        if (pl.hand.includes(n)) {
          if (playTo(st, owner, n, prefs, ctx)) { placed++; done = true; break; }
        }
      }
      if (!done && pressure >= 1) {
        const assCount = pl.hand.filter(c => c === "ASSB").length;
        if (assCount >= (pressure >= 2 ? 1 : 2)) {
          if (playTo(st, owner, "ASSB", prefs, ctx)) { placed++; done = true; }
        }
      }
      if (!done) break;
      if (st.winner) return;
    }

    if (pl.hand.length >= 6) {
      for (const n of ["ASSB", "SPB"]) {
        if (pl.hand.filter(c => c === n).length >= 2) { playTo(st, owner, n, prefs, ctx); break; }
      }
    }

    chooseAttacks(st, owner, ctx, {});
  }

  /* --- 墨綠圖騰 --- */
  function totemTurn(st, owner) {
    const prefs = { fragile: ["AP", "SP", "ASS", "ADC", "APT"] };
    const ctx = turnContext(st, owner);
    const pl = st.players[owner];

    if (ctx.canWinNow) { chooseAttacks(st, owner, ctx, {}); return; }

    if (ctx.enemyLethal) {
      desperationPush(st, owner, prefs, ctx,
        ["LFDKG", "APDKG", "APTDKG", "ADCDKG", "TANKDKG", "SPDKG"]);
      return;
    }

    const placeLimit = ctx.boardGap >= 2 ? 4 : (ctx.boardGap >= 1 ? 3 : 2);
    const tryPlay = (n) => pl.hand.includes(n) && playTo(st, owner, n, prefs, ctx);
    let placed = 0;
    for (const n of ["TANKDKG", "APDKG"]) {
      while (placed < placeLimit && tryPlay(n)) { placed++; if (st.winner) return; }
    }
    if (placed < placeLimit && st.totem[owner] >= 4) { if (tryPlay("SPDKG")) placed++; }
    if (placed < placeLimit && st.totem[owner] >= 6) { if (tryPlay("APTDKG")) placed++; }
    if (placed < placeLimit && st.totem[owner] >= 8 && tryPlay("LFDKG")) placed++;
    if (placed < placeLimit && tryPlay("ADCDKG")) placed++;
    if (pl.hand.length >= 6 || (ctx.boardGap >= 2 && placed < placeLimit)) {
      for (const n of ["ADCDKG", "APTDKG", "SPDKG", "LFDKG"]) { if (tryPlay(n)) break; }
    }
    chooseAttacks(st, owner, ctx, {});
  }

  /* --- 通用 AI:對任意自訂套牌生效 (對戰模式的電腦方) --- */
  function desperationOrder(hand) {
    const score = (n) => {
      const job = E.jobOf(n);
      if (n === "SPB") return 10;       // 轟炸計分單位
      if (job === "ASS") return 9;      // 進場即可出刀
      if (n === "LFDKG") return 8;      // 進場傷害
      return E.STATS[n] ? E.STATS[n].dmg : 0;
    };
    return [...new Set(hand)].sort((a, b) => score(b) - score(a));
  }

  function shouldHold(st, owner, name, ctx, pressure) {
    const job = E.jobOf(name);
    if (name === "SPB") {
      const pings = st.players[owner].onBoard.length + st.players[owner].discard.length;
      const enemyTotalHp = ctx.theirs.reduce((s, c) => s + c.hp + c.armor, 0);
      return !(pings >= Math.max(6, enemyTotalHp * 0.55) || ctx.round >= 6 || pressure >= 2);
    }
    if (name === "LFDKG") return st.totem[owner] < 8 && ctx.round < 6 && pressure < 2;
    if (name === "APTDKG") return st.totem[owner] < 6 && ctx.round < 5 && pressure < 2;
    if (name === "SPDKG") return st.totem[owner] < 4 && ctx.round < 4 && pressure < 2;
    if (job === "ASS") {
      if (pressure >= 1 || ctx.round >= 5) return false;
      const dmg = E.STATS[name].dmg;
      return !ctx.theirs.some(e => e.hp + e.armor <= dmg); // 沒有斬殺目標就先留手
    }
    return false;
  }

  function placePriority(st, owner, name) {
    const job = E.jobOf(name);
    let p = { TANK: 5, HF: 4, AP: 3.5, APT: 3, LF: 2.5, ADC: 2, SP: 1.5, ASS: 1 }[job] || 1;
    if (name === "HFP") p = 4.5;
    // 同派系協同 (引擎共鳴):場上同色越多,後續同色卡優先度微升
    const sameColor = st.players[owner].onBoard.filter(c => c.color === E.colorOf(name)).length;
    p += Math.min(sameColor * 0.12, 0.6);
    return p;
  }

  function genericTurn(st, owner) {
    const prefs = { fragile: ["AP", "SP", "ASS", "ADC", "APT"] };
    const ctx = turnContext(st, owner);
    const pl = st.players[owner];

    if (ctx.canWinNow) { chooseAttacks(st, owner, ctx, {}); return; }
    if (ctx.enemyLethal) {
      desperationPush(st, owner, prefs, ctx, desperationOrder(pl.hand));
      return;
    }

    const pressure = ctx.boardGap + (ctx.behind ? Math.min(-ctx.myLead / 3, 3) : 0);
    const placeLimit = pressure >= 2 ? 4 : (pressure >= 1 ? 3 : 2);
    let placed = 0, guard = 0;
    while (placed < placeLimit && guard++ < 14) {
      const cands = [...new Set(pl.hand)].filter(n => n !== "MOVEO" && !shouldHold(st, owner, n, ctx, pressure));
      if (!cands.length) break;
      cands.sort((a, b) => placePriority(st, owner, b) - placePriority(st, owner, a));
      if (!playTo(st, owner, cands[0], prefs, ctx)) break;
      placed++;
      if (st.winner) return;
    }
    // 手牌爆滿洩壓 (壓著不放只會乾抓)
    if (pl.hand.length >= 6) {
      const all = [...new Set(pl.hand)].sort((a, b) => placePriority(st, owner, b) - placePriority(st, owner, a));
      if (all.length) playTo(st, owner, all[0], prefs, ctx);
    }
    chooseAttacks(st, owner, ctx, {});
  }

  const AI_BY_DECK = {
    blueControl: blueTurn,
    redWhiteAggro: aggroTurn,
    darkGreenTotem: totemTurn,
  };

  /* 對外: 讓任意座位的 AI 走完一個回合 (預設流派用專屬策略,自訂套牌用通用策略) */
  function aiTakeTurn(st, owner) {
    const deckId = st.deckOf && st.deckOf[owner];
    const fn = (deckId && AI_BY_DECK[deckId]) || genericTurn;
    fn(st, owner);
    drainMoves(st, owner);
  }

  /* 移動鏈收尾:處理橘卡攻擊後的 moving 狀態 / MOVEO / 移動點 (一步模擬選目的地) */
  function moveDests(st, card) {
    const out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nx = card.x + dx, ny = card.y + dy;
      if (E.validPos(nx, ny) && !E.cellOccupied(st, nx, ny)) out.push([nx, ny]);
    }
    return out;
  }

  function drainMoves(st, owner) {
    let guard = 0;
    while (guard++ < 12 && !st.winner) {
      const pl = st.players[owner];
      const movers = E.alive(pl.onBoard).filter(c => c.moving);
      if (movers.length) {
        const m = movers[0];
        const base = evalPosition(st, owner, W_NORMAL);
        let bestD = null, bestV = -Infinity;
        for (const d of moveDests(st, m)) {
          const cl = E.cloneState(st);
          const cm = cl.players[owner].onBoard.find(c => c.uid === m.uid);
          if (!cm) break;
          cm.moving = true;
          if (!E.moveCard(cl, cm, d[0], d[1])) continue;
          const v = evalPosition(cl, owner, W_NORMAL) - base;
          if (v > bestV) { bestV = v; bestD = d; }
        }
        if (bestD && bestV > -2) {
          E.moveCard(st, m, bestD[0], bestD[1]);
          E.snapshot(st, `${E.zh(owner)} 移動`);
        } else m.moving = false;
        continue;
      }
      // 沒有待移動者: 用移動點武裝最有價值的單位
      if (st.movings[owner] > 0) {
        const base = evalPosition(st, owner, W_NORMAL);
        let best = null, bestDelta = 0.3;
        for (const u of E.alive(pl.onBoard)) {
          if (u.numbness || u.moving) continue;
          for (const d of moveDests(st, u)) {
            const cl = E.cloneState(st);
            const cu = cl.players[owner].onBoard.find(c => c.uid === u.uid);
            if (!cu) continue;
            cu.moving = true;
            if (!E.moveCard(cl, cu, d[0], d[1])) continue;
            const delta = evalPosition(cl, owner, W_NORMAL) - base;
            if (delta > bestDelta) { bestDelta = delta; best = [u, d]; }
          }
        }
        if (best && E.spendMoving(st, owner, best[0])) continue;
      }
      // MOVEO 在手且場上有可動單位 → 用掉換移動點
      const mi = pl.hand.indexOf("MOVEO");
      if (mi >= 0 && st.movings[owner] === 0 &&
          E.alive(pl.onBoard).some(c => !c.numbness && moveDests(st, c).length)) {
        E.playCard(st, owner, mi, 0, 0);
        continue;
      }
      break;
    }
  }

  /* =====================================================================
   * 整場對局
   * =================================================================== */
  function runGame(deckAId, deckBId, seed, opts) {
    opts = opts || {};
    const flip = !!opts.flip;
    const p1Deck = flip ? DECKS[deckBId] : DECKS[deckAId];
    const p2Deck = flip ? DECKS[deckAId] : DECKS[deckBId];
    const st = E.createState(p1Deck.cards, p2Deck.cards, seed, { record: opts.record, maxTurns: opts.maxTurns || 60 });
    st.deckOf = { player1: p1Deck.id, player2: p2Deck.id };
    st.deckLists = { player1: p1Deck.cards.slice(), player2: p2Deck.cards.slice() };
    // 控制器: "sim" = 模擬器AI, "camp" = 戰役AI (預設依套牌)
    const ctlSpec = opts.controllers || {};
    st.controllers = {
      player1: ctlSpec.player1 || p1Deck.defaultController || "sim",
      player2: ctlSpec.player2 || p2Deck.defaultController || "sim",
    };
    st.campBuffs = !!opts.campBuffs;
    const ctlLabel = (p, d) => st.controllers[p] === "camp" ? "戰役AI" : "模擬器AI";
    st.log.push(`對局開始: 玩家1=${p1Deck.label}(${ctlLabel("player1", p1Deck)}) vs 玩家2=${p2Deck.label}(${ctlLabel("player2", p2Deck)}) (seed ${seed})`);
    E.snapshot(st, "開局");

    let guard = 0;
    while (!st.winner && guard++ < 400) {
      const cur = E.currentPlayer(st);
      if (st.controllers[cur] === "camp") {
        const deck = DECKS[st.deckOf[cur]];
        const stage = (deck && deck.stage) || CAMP.stageForDeck(st.deckLists[cur]);
        CAMP.takeTurn(st, cur, stage, { buffs: st.campBuffs });
      } else {
        aiTakeTurn(st, cur);
      }
      if (st.winner) break;
      E.endTurn(st);
      E.snapshot(st, "回合結束");
    }
    if (!st.winner) st.winner = st.score < 0 ? "player1" : (st.score > 0 ? "player2" : "tie");

    const winnerDeck = st.winner === "tie" ? "tie" : st.deckOf[st.winner];
    return {
      state: st,
      winner: st.winner,
      winnerDeck,
      turns: st.turnNumber,
      finalScore: st.score,
      scoreHistory: st.scoreHistory.slice(),
      deckOf: { ...st.deckOf },
      record: st.record,
    };
  }

  function runBatch(deckAId, deckBId, n, baseSeed, onProgress, batchOpts) {
    batchOpts = batchOpts || {};
    const res = {
      deckA: deckAId, deckB: deckBId, games: n,
      winsA: 0, winsB: 0, ties: 0,
      winsAFirst: 0, gamesAFirst: 0, winsASecond: 0, gamesASecond: 0,
      totalTurns: 0, scoreCurves: [], lengths: [],
    };
    for (let i = 0; i < n; i++) {
      const flip = i % 2 === 1;
      const ctlA = batchOpts.ctlA, ctlB = batchOpts.ctlB;
      const controllers = (ctlA || ctlB) ? {
        player1: flip ? ctlB : ctlA,
        player2: flip ? ctlA : ctlB,
      } : undefined;
      const g = runGame(deckAId, deckBId, baseSeed + i * 7919, { flip, controllers, campBuffs: batchOpts.campBuffs });
      // 依座位計勝負 (鏡像對局雙方套牌 id 相同,不能用 winnerDeck 判斷)
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
      if (onProgress && i % 10 === 9) onProgress(i + 1, n);
    }
    return res;
  }

  root.ABAI = { DECKS, runGame, runBatch, emptyCells, turnContext, evalPosition, opponentInfo, enemyThreat, aiTakeTurn, genericTurn, cellHeuristic, dangerAt };
})(typeof module !== "undefined" ? module.exports : (window.AB = window.AB || {}));
