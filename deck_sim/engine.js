/* =====================================================================
 * 午後激盪 對局模擬引擎 (Afternoon Brainstorming battle simulator)
 * 依 4.0.4.2 版原始碼 (cards/*.py, core/*.py) 重新實作之 JS 子集。
 * 涵蓋派系: 白 / 紅 / 藍 / 墨綠 / 紫(HFP)
 * 可同時在瀏覽器與 Node 執行 (無 DOM 依賴)。
 * ===================================================================== */
(function (root) {
  "use strict";

  /* ---------- RNG (mulberry32, 可播種重現) ---------- */
  function makeRng(seed) {
    let a = seed >>> 0;
    const next = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      random: next,
      randint: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), // 含兩端
      choice: (arr) => arr[Math.floor(next() * arr.length)],
      shuffle: (arr) => {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
      },
      getState: () => a >>> 0,
      setState: (v) => { a = v >>> 0; },
    };
  }

  /* ---------- 卡牌數值 (config/card_setting.json 摘錄) ---------- */
  const STATS = {
    ADCW: { hp: 5, dmg: 4 }, APW: { hp: 4, dmg: 3 }, TANKW: { hp: 15, dmg: 1 },
    HFW: { hp: 9, dmg: 2 }, LFW: { hp: 7, dmg: 4 }, ASSW: { hp: 2, dmg: 5 },
    APTW: { hp: 8, dmg: 2 }, SPW: { hp: 1, dmg: 5 },

    ADCR: { hp: 4, dmg: 2 }, APR: { hp: 3, dmg: 2 }, TANKR: { hp: 9, dmg: 1 },
    HFR: { hp: 8, dmg: 1 }, LFR: { hp: 6, dmg: 2 }, ASSR: { hp: 2, dmg: 4 },
    APTR: { hp: 6, dmg: 2 }, SPR: { hp: 1, dmg: 5 },

    ADCB: { hp: 4, dmg: 2 }, APB: { hp: 4, dmg: 2 }, TANKB: { hp: 10, dmg: 1 },
    HFB: { hp: 8, dmg: 2 }, LFB: { hp: 7, dmg: 3 }, ASSB: { hp: 2, dmg: 4 },
    APTB: { hp: 5, dmg: 3 }, SPB: { hp: 1, dmg: 5 },

    ADCDKG: { hp: 4, dmg: 2 }, APDKG: { hp: 3, dmg: 3 }, TANKDKG: { hp: 9, dmg: 1 },
    HFDKG: { hp: 8, dmg: 2 }, LFDKG: { hp: 6, dmg: 3 }, ASSDKG: { hp: 2, dmg: 4 },
    APTDKG: { hp: 6, dmg: 0 }, SPDKG: { hp: 1, dmg: 5 },

    APP: { hp: 3, dmg: 1 }, TANKP: { hp: 9, dmg: 1 }, HFP: { hp: 8, dmg: 1 },
    ASSP: { hp: 2, dmg: 3 },

    ADCO: { hp: 4, dmg: 2 }, APO: { hp: 3, dmg: 2 }, TANKO: { hp: 10, dmg: 1 },
    HFO: { hp: 9, dmg: 1 }, LFO: { hp: 6, dmg: 3 }, ASSO: { hp: 2, dmg: 3 },
    APTO: { hp: 6, dmg: 0 }, SPO: { hp: 1, dmg: 5 },

    ADCG: { hp: 3, dmg: 3 }, APG: { hp: 3, dmg: 2 }, TANKG: { hp: 9, dmg: 1 },
    HFG: { hp: 8, dmg: 1 }, LFG: { hp: 6, dmg: 3 }, ASSG: { hp: 2, dmg: 4 },
    APTG: { hp: 5, dmg: 0 }, SPG: { hp: 1, dmg: 5 },

    CUBE: { hp: 4, dmg: 0 },
    LUCKYBLOCK: { hp: 1, dmg: 0 },
    MOVEO: { hp: 0, dmg: 0 },
    MOVE: { hp: 0, dmg: 0 },
    HEAL: { hp: 0, dmg: 0 },
    CUBES: { hp: 0, dmg: 0 },
  };

  /* ---------- 職業攻擊模式 (config/job_dictionary.json) ---------- */
  const ATTACK_TYPES = {
    ADC: "large_cross", AP: "nearest", TANK: "small_cross",
    HF: "small_cross small_x", LF: "small_cross", ASS: "small_x",
    APT: "nearest", SP: "farthest", CUBE: "", LUCKYBLOCK: "",
    MOVEO: "", MOVE: "", HEAL: "", CUBES: "",
  };

  const COLOR_SUFFIXES = ["DKG", "W", "R", "B", "P", "O", "G"]; // 長的優先
  const SPECIAL_NAMES = new Set(["CUBE", "LUCKYBLOCK", "MOVEO", "MOVE", "HEAL", "CUBES"]);
  function jobOf(name) {
    if (SPECIAL_NAMES.has(name)) return name;
    for (const suf of COLOR_SUFFIXES) {
      if (name.endsWith(suf)) return name.slice(0, name.length - suf.length);
    }
    return name;
  }
  function colorOf(name) {
    if (name === "LUCKYBLOCK") return "Green";
    if (SPECIAL_NAMES.has(name)) return "Neutral";
    if (name.endsWith("DKG")) return "DarkGreen";
    if (name.endsWith("W")) return "White";
    if (name.endsWith("R")) return "Red";
    if (name.endsWith("B")) return "Blue";
    if (name.endsWith("P")) return "Purple";
    if (name.endsWith("O")) return "Orange";
    if (name.endsWith("G")) return "Green";
    return "Neutral";
  }

  let UID = 0;

  function makeCard(name, owner, x, y) {
    const st = STATS[name];
    if (!st) throw new Error("unknown card: " + name);
    const job = jobOf(name);
    return {
      uid: ++UID,
      name, job,
      color: colorOf(name),
      owner, x, y,
      hp: st.hp, maxHp: st.hp,
      dmg: st.dmg, originalDmg: st.dmg,
      armor: 0, extraDamage: 0,
      numbness: job !== "ASS",       // 進場麻痺,刺客除外 (base.py)
      anger: false,
      attackTypes: ATTACK_TYPES[job],
    };
  }

  /* =====================================================================
   * GameState
   * =================================================================== */
  function createState(deck1, deck2, seed, opts) {
    opts = opts || {};
    const rng = makeRng(seed);
    const st = {
      rng,
      turnNumber: 0,
      score: 0,                 // 負 = player1 領先 (battling_dispatcher.py)
      winner: null,
      players: {
        player1: makePlayer("player1", deck1),
        player2: makePlayer("player2", deck2),
      },
      neutral: [],               // 中立單位 (CUBE)
      attacks: { player1: 0, player2: 0 },   // 刀數
      tokens: { player1: 0, player2: 0 },    // 藍球
      totem: { player1: 0, player2: 0 },     // 圖騰
      luck: { player1: 50, player2: 50, neutral: 50 },   // 運氣值 (綠色)
      movings: { player1: 0, player2: 0 },   // 可用移動次數 (MOVEO/增益)
      heals: { player1: 0, player2: 0 },     // 可用回血次數 (HEAL)
      cubes: { player1: 0, player2: 0 },     // 可放方塊數 (CUBES)
      drawScript: opts.drawScript || null,   // 鏡像模式: 強制抽牌順序 {player1:[...names]}
      cardToDraw: { player1: 0, player2: 0 },
      pendingAttacks: [],
      attackDraining: false,
      log: [],
      record: opts.record ? [] : null,
      maxTurns: opts.maxTurns || 60,         // end_turn 次數上限 (各 30 回合)
      scoreHistory: [],                      // 每次 end_turn 後的 score
    };
    // Player.initialize: discard = deck.copy → 抽 3 張 (抽光觸發洗牌)
    for (const p of ["player1", "player2"]) {
      st.players[p].discard = st.players[p].deck.slice();
      for (let i = 0; i < 3; i++) drawCard(st, p);
    }
    st.attacks.player1 += 1; // 先手第一回合的刀
    return st;
  }

  function makePlayer(name, deck) {
    return { name, deck: deck.slice(), hand: [], onBoard: [], drawPile: [], discard: [] };
  }

  function currentPlayer(st) { return st.turnNumber % 2 === 0 ? "player1" : "player2"; }
  function opponentOf(p) { return p === "player1" ? "player2" : "player1"; }

  function logf(st, msg) {
    st.log.push(msg);
    // 批量模擬不錄影時防爆: 上限裁切 (UI 模式每動作都會 drain,不受影響)
    if (st.log.length > 1500) st.log.splice(0, st.log.length - 1000);
  }

  /* ---------- 棋盤工具 ---------- */
  const W = 4, H = 4;
  function cellOccupied(st, x, y) {
    return allCards(st).some(c => c.hp > 0 && c.x === x && c.y === y);
  }
  function allCards(st) {
    return st.players.player1.onBoard.concat(st.players.player2.onBoard, st.neutral);
  }
  function sideCards(st, owner, getOpponent) {
    const base = getOpponent ? st.players[opponentOf(owner)].onBoard : st.players[owner].onBoard;
    return base.concat(st.neutral);
  }
  function alive(list) { return list.filter(c => c.hp > 0); }

  /* ---------- detection (base.py) ---------- */
  function detection(card, types, targets, st) {
    const out = [];
    const list = targets.filter(c => c.hp > 0);
    for (const t of types.split(" ")) {
      if (!t) continue;
      if (t === "small_cross") {
        for (const c of list) {
          const dx = Math.abs(c.x - card.x), dy = Math.abs(c.y - card.y);
          if ((dx === 1 && dy === 0) || (dx === 0 && dy === 1)) out.push(c);
        }
      } else if (t === "large_cross") {
        for (const c of list) {
          if ((c.x === card.x || c.y === card.y) && !(c.x === card.x && c.y === card.y)) out.push(c);
        }
      } else if (t === "small_x") {
        for (const c of list) {
          if (Math.abs(c.x - card.x) === 1 && Math.abs(c.y - card.y) === 1) out.push(c);
        }
      } else if (t === "nearest" || t === "farthest") {
        if (list.length) {
          const dist = c => Math.abs(c.x - card.x) + Math.abs(c.y - card.y);
          const sorted = list.slice().sort((a, b) => t === "nearest" ? dist(a) - dist(b) : dist(b) - dist(a));
          const best = dist(sorted[0]);
          const ties = sorted.filter(c => dist(c) === best);
          out.push(st.rng.choice(ties));
        }
      }
    }
    return out;
  }

  /* 純評估用: nearest/farthest 回傳所有平手候選 (不消耗亂數) */
  function detectionCandidates(card, types, targets) {
    const out = [];
    const list = targets.filter(c => c.hp > 0);
    for (const t of types.split(" ")) {
      if (!t) continue;
      if (t === "small_cross" || t === "large_cross" || t === "small_x") {
        for (const c of list) {
          const dx = Math.abs(c.x - card.x), dy = Math.abs(c.y - card.y);
          if (t === "small_cross" && ((dx === 1 && dy === 0) || (dx === 0 && dy === 1))) out.push(c);
          if (t === "large_cross" && (c.x === card.x || c.y === card.y) && !(dx === 0 && dy === 0)) out.push(c);
          if (t === "small_x" && dx === 1 && dy === 1) out.push(c);
        }
      } else if (t === "nearest" || t === "farthest") {
        if (list.length) {
          const dist = c => Math.abs(c.x - card.x) + Math.abs(c.y - card.y);
          const sorted = list.slice().sort((a, b) => t === "nearest" ? dist(a) - dist(b) : dist(b) - dist(a));
          const best = dist(sorted[0]);
          out.push({ group: sorted.filter(c => dist(c) === best) });
        }
      }
    }
    return out;
  }

  /* =====================================================================
   * 卡牌效果掛勾 (依各 card_xxx.py)
   * =================================================================== */

  function ownSPRs(st, owner) {
    return st.players[owner].onBoard.filter(c => c.name === "SPR" && c.hp > 0);
  }
  function nearestOwnOther(st, card) {
    const others = st.players[card.owner].onBoard.filter(c => c !== card && c.hp > 0);
    return detection(card, "nearest", others, st);
  }

  /* --- 藍球引擎 (card_blue.py) --- */
  function gotToken(st, owner) {
    // after_token: APTB 護盾 (本模擬套牌未含 APTB,保留掛勾)
    for (const c of alive(st.players[owner].onBoard)) {
      if (c.name === "APTB") c.armor += 1;
    }
    if (st.tokens[owner] >= 3) {
      st.tokens[owner] -= 3;
      st.cardToDraw[owner] += 1;
      logf(st, `${zh(owner)} 藍球滿3 → 抽1張牌`);
      // token_draw: 所有藍卡觸發 → ADCB 解麻痺或免費攻擊
      for (const c of alive(st.players[owner].onBoard)) {
        if (c.name === "ADCB") {
          if (c.numbness) { c.numbness = false; logf(st, `ADCB 抽牌解除麻痺`); }
          else { st.pendingAttacks.push({ attacker: c, types: null }); logf(st, `ADCB 因抽牌準備免費攻擊`); }
        }
      }
    }
  }

  /* --- 圖騰刻印 (card_dark_green.py) --- */
  function engrave(st, owner, times) {
    const mult = Math.pow(2, st.players[owner].onBoard.filter(c => c.name === "SPDKG" && c.hp > 0).length);
    st.totem[owner] += times * mult;
  }

  /* --- 幸運系統 (card_green.py) --- */
  function spawnLuckyBlock(st, x, y) {
    if (!validPos(x, y) || cellOccupied(st, x, y)) return false;
    st.neutral.push(makeCard("LUCKYBLOCK", "neutral", x, y));
    return true;
  }

  function luckyEffects(st, target, opts) {
    opts = opts || {};
    const luckOf = st.luck[target.owner] !== undefined ? st.luck[target.owner] : 50;
    if (!opts.APTarget && st.rng.randint(1, 100) <= luckOf) {
      if (opts.APTarget || opts.TANK) return;       // TANKG: 運氣好則無事
      st.luck[target.owner] = luckOf + 1;
      switch (st.rng.randint(1, 5)) {
        case 1: target.armor += 4; logf(st, `${target.name} 好運: +4 護甲`); break;
        case 2: target.dmg *= 2; logf(st, `${target.name} 好運: 攻擊×2`); break;
        case 3:
          st.pendingAttacks.push({ attacker: target, types: null });
          logf(st, `${target.name} 好運: 免費攻擊一次`); break;
        case 4: target.moving = true; logf(st, `${target.name} 好運: 獲得移動`); break;
        case 5: {
          if (opts.AP) return; // 綠法師此項無效
          for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            if (spawnLuckyBlock(st, target.x + dx, target.y + dy)) {
              logf(st, `好運: 幸運方塊生成於 (${target.x + dx},${target.y + dy})`);
            }
          }
          break;
        }
      }
    } else {
      if (opts.AP) return; // 綠法師自身: 壞運跳過
      if (st.luck[target.owner] !== undefined) st.luck[target.owner] -= 1;
      switch (st.rng.randint(1, 5)) {
        case 1: target.armor = 0; logf(st, `${target.name} 壞運: 破甲`); break;
        case 2: target.numbness = true; logf(st, `${target.name} 壞運: 麻痺`); break;
        case 3: target.hp = Math.floor(target.hp / 2); logf(st, `${target.name} 壞運: 血量減半`); break;
        case 4: target.dmg = Math.floor(target.dmg / 2); logf(st, `${target.name} 壞運: 攻擊減半`); break;
        case 5:
          if (target.hp >= 2) { target.hp -= 2; logf(st, `${target.name} 壞運: -2 血`); }
          break;
      }
    }
  }

  /* ability: 攻擊命中時觸發 (damage_calculate 內、傷害套用前) */
  function abilityOf(st, attacker, target) {
    switch (attacker.name) {
      case "APW":
        target.numbness = true; return true;
      case "ADCR": {
        attacker.dmg += 1;
        for (const s of ownSPRs(st, attacker.owner)) s.dmg += 1;
        return true;
      }
      case "APR": {
        target.numbness = true;
        const v = Math.floor(target.dmg * 1.0); // attack_steal_rate 100%
        attacker.dmg += v; target.dmg -= v;
        for (const s of ownSPRs(st, attacker.owner)) s.dmg += v;
        if (v > 0) logf(st, `APR 偷取 ${zh(target.owner)} ${target.name} 全部 ${v} 點攻擊`);
        return true;
      }
      case "LFR": {
        attacker.armor += 1; attacker.dmg += 1;
        for (const s of ownSPRs(st, attacker.owner)) { s.armor += 1; s.dmg += 1; }
        return true;
      }
      case "HFR": {
        // 每次造成傷害 -1血 +1攻 (原版死亡延遲至回合結束,此處簡化為即時)
        attacker.hp -= 1;
        attacker.dmg += 1;
        for (const s of ownSPRs(st, attacker.owner)) s.dmg += 1;
        return true;
      }
      case "APTB": {
        const t = Math.floor(attacker.armor / 3); // 每3點護盾獲得1顆藍球
        if (t > 0) {
          st.tokens[attacker.owner] += t;
          for (let i = 0; i < t; i++) gotToken(st, attacker.owner);
        }
        return true;
      }
      case "APTR": {
        for (const c of nearestOwnOther(st, attacker)) { c.armor += 1; c.dmg += 1; }
        for (const s of ownSPRs(st, attacker.owner)) { s.armor += 1; s.dmg += 1; }
        attacker.armor += 1; attacker.dmg += 1;
        return true;
      }
      case "APTW": {
        for (const c of nearestOwnOther(st, attacker)) c.armor += attacker.dmg;
        attacker.armor += attacker.dmg;
        return true;
      }
      case "APB": {
        target.numbness = true;
        st.tokens[attacker.owner] += 2;
        gotToken(st, attacker.owner); gotToken(st, attacker.owner);
        return true;
      }
      case "LFB": {
        st.tokens[attacker.owner] += 1; gotToken(st, attacker.owner);
        return true;
      }
      case "APDKG": {
        target.numbness = true;
        engrave(st, attacker.owner, 5);
        return true;
      }
      case "LFDKG": {
        engrave(st, attacker.owner, 1);
        return true;
      }
      case "HFDKG": {
        healCard(attacker, 1);
        return true;
      }
      case "APP": {
        target.numbness = true;
        target.armor = 0; target.dmg = target.originalDmg;
        return true;
      }
      case "APO": {
        target.numbness = true;
        return true;
      }
      case "APG": {
        target.numbness = true;
        luckyEffects(st, target, { APTarget: true });   // 目標必中隨機壞運
        luckyEffects(st, attacker, { AP: true });       // 自身依運氣獲得好運或無
        return true;
      }
      case "ADCG": {
        // 攻擊後 50% 在攻擊範圍 (同排同列) 空格生成幸運方塊
        for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
          if ((x === attacker.x || y === attacker.y) && !(x === attacker.x && y === attacker.y)) {
            if (!cellOccupied(st, x, y) && st.rng.randint(1, 100) <= 50) spawnLuckyBlock(st, x, y);
          }
        }
        return true;
      }
      case "HFG": {
        if (target.name === "LUCKYBLOCK") {
          st.luck[attacker.owner] += 5;
          const empties = [];
          for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
            if (!cellOccupied(st, x, y)) empties.push([x, y]);
          }
          if (empties.length) {
            const [bx, by] = st.rng.choice(empties);
            spawnLuckyBlock(st, bx, by);
          }
        }
        return true;
      }
      default: return false;
    }
  }

  /* damage_bonus: 傷害加成 */
  function damageBonus(st, attacker, value) {
    switch (attacker.name) {
      case "HFB": return value + st.tokens[attacker.owner];
      case "ADCDKG": return value + Math.floor(st.totem[attacker.owner] / 4);
      case "APTDKG": {
        engrave(st, attacker.owner, Math.floor(attacker.armor / 2));
        return value + Math.floor(st.totem[attacker.owner] / 2);
      }
      default: return value + attacker.extraDamage;
    }
  }

  /* been_attacked: 承受傷害後 */
  function beenAttacked(st, self, attacker, value) {
    switch (self.name) {
      case "TANKR": {
        for (const c of nearestOwnOther(st, self)) c.armor += 2;
        for (const s of ownSPRs(st, self.owner)) s.armor += 2;
        break;
      }
      case "TANKB": {
        st.tokens[self.owner] += 1; gotToken(st, self.owner);
        break;
      }
      case "TANKDKG": {
        engrave(st, self.owner, 2);
        break;
      }
      case "TANKG": {
        luckyEffects(st, attacker, { TANK: true });   // 依攻擊者運氣附加壞運或無
        break;
      }
      case "TANKO": {
        st.players[self.owner].hand.push("MOVEO");
        logf(st, `TANKO 被攻擊 → 獲得 MOVEO`);
        break;
      }
    }
  }

  /* killed: 斬殺敵人後 */
  function onKilled(st, attacker, victim) {
    switch (attacker.name) {
      case "ASSR": {
        for (const c of nearestOwnOther(st, attacker)) c.dmg += 2;
        for (const s of ownSPRs(st, attacker.owner)) s.dmg += 2;
        break;
      }
      case "ADCB": {
        // 戰役版平衡: token_gets 2 → 1 (campaign repo card_setting.json)
        st.tokens[attacker.owner] += 1; gotToken(st, attacker.owner);
        break;
      }
      case "LFG": {
        if (victim.name === "LUCKYBLOCK") {
          const opps = alive(st.players[opponentOf(attacker.owner)].onBoard);
          for (const t of detection(attacker, "nearest", opps, st)) {
            damageCalculate(st, t, attacker.dmg, attacker, false);
          }
          if (st.rng.randint(1, 100) <= 25) {
            st.attacks[attacker.owner] += 1;
            logf(st, `LFG 破壞幸運方塊 → 返還 1 刀`);
          }
        }
        break;
      }
      case "ASSG": {
        st.luck[attacker.owner] += 5;
        st.luck[opponentOf(attacker.owner)] -= 5;
        break;
      }
      case "ASSO": {
        attacker.moving = true;
        if (attacker.anger) {
          st.attacks[attacker.owner] += 1;
          attacker.anger = false;
          logf(st, `ASSO 狂暴斬殺 → 返還 1 刀`);
        }
        break;
      }
      case "ASSB": {
        st.tokens[attacker.owner] += 2;
        gotToken(st, attacker.owner); gotToken(st, attacker.owner);
        break;
      }
      case "ASSDKG": {
        attacker.hp = 0; engrave(st, attacker.owner, 7);
        break;
      }
      case "ASSP": {
        const gap = st.players[victim.owner === "neutral" ? opponentOf(attacker.owner) : victim.owner].onBoard.length
                  - st.players[attacker.owner].onBoard.length - 2;
        const n = Math.min(Math.max(gap, 0), 12);
        st.cardToDraw[attacker.owner] += n;
        if (n > 0) logf(st, `ASSP 斬殺 → 抽 ${n} 張牌`);
        break;
      }
    }
  }

  /* after_damage_calculated */
  function afterDamage(st, attacker, target, value) {
    if (attacker.name === "APTDKG") attacker.armor += Math.floor(value / 2);
  }

  /* on_refresh: 我方回合開始 */
  function onRefresh(st, card) {
    switch (card.name) {
      case "HFP": {
        const enemies = alive(st.players[opponentOf(card.owner)].onBoard); // 不含中立
        const n = detectionCandidates(card, "small_cross small_x", enemies)
          .filter(e => !e.group).length;
        const gain = Math.floor(n / 3);
        if (gain > 0) {
          st.attacks[card.owner] += gain;
          logf(st, `HFP 偵測 ${n} 個敵人 → ${zh(card.owner)} +${gain} 刀`);
        }
        break;
      }
      case "HFDKG": {
        damageCalculate(st, card, 2, card, false);
        engrave(st, card.owner, 2);
        break;
      }
      case "APO": {
        st.players[card.owner].hand.push("MOVEO");
        logf(st, `APO 回合開始 → 獲得 MOVEO`);
        break;
      }
      case "APTG": {
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          if (spawnLuckyBlock(st, card.x + dx, card.y + dy)) {
            logf(st, `APTG 生成幸運方塊於 (${card.x + dx},${card.y + dy})`);
          }
        }
        break;
      }
    }
  }

  /* deploy: 進場效果 (spawn_card 在加入棋盤前呼叫) */
  function onDeploy(st, card) {
    switch (card.name) {
      case "SPB": {
        const own = st.players[card.owner];
        const count = own.onBoard.length + own.discard.length;
        logf(st, `SPB 進場 → 隨機轟炸 ${count} 次 (場上${own.onBoard.length}+棄牌${own.discard.length})`);
        for (let i = 0; i < count; i++) {
          const enemies = alive(sideCards(st, card.owner, true));
          if (!enemies.length) break;
          const t = st.rng.choice(enemies);
          damageCalculate(st, t, 1, card, true);
        }
        recycleDead(st);
        break;
      }
      case "LFDKG": {
        const v = Math.floor(st.totem[card.owner] / 4);
        if (v > 0) {
          const enemies = alive(sideCards(st, card.owner, true));
          for (const t of detection(card, "small_cross", enemies, st)) {
            damageCalculate(st, t, v, card, true);
          }
          recycleDead(st);
        }
        break;
      }
      case "APP": {
        const enemies = alive(st.players[opponentOf(card.owner)].onBoard);
        for (const t of detection(card, "nearest", enemies, st)) {
          t.armor = 0; t.dmg = t.originalDmg;
          logf(st, `APP 進場 → ${t.name} 破甲且攻擊重置`);
        }
        break;
      }
      case "SPG": {
        st.luck[card.owner] += 10;
        const luck = st.luck[card.owner];
        if (luck > 50) {
          const empties = [];
          for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
            if (!cellOccupied(st, x, y) && !(x === card.x && y === card.y)) empties.push([x, y]);
          }
          st.rng.shuffle(empties);
          const n = Math.min(Math.floor((luck - 50) / 10), empties.length);
          for (let i = 0; i < n; i++) spawnLuckyBlock(st, empties[i][0], empties[i][1]);
          if (n > 0) logf(st, `SPG 進場 → 生成 ${n} 個幸運方塊`);
        }
        break;
      }
    }
  }

  function healCard(card, value) {
    if (card.hp + value <= card.maxHp) { card.hp += value; }
    else {
      const overflow = card.hp + value - card.maxHp;
      card.armor += Math.floor(overflow / 2);
      card.hp = card.maxHp;
    }
  }

  /* =====================================================================
   * 傷害結算 (base.py damage_calculate)
   * =================================================================== */
  function damageCalculate(st, self, value, attacker, useAbility) {
    if (self.hp <= 0) return false;

    if (useAbility) abilityOf(st, attacker, self);

    value = damageBonus(st, attacker, value);
    // (damage_reduce / interceptor: 本子集無對應卡)

    if (self.armor > 0 && self.armor >= value) {
      self.armor -= value;
      beenAttacked(st, self, attacker, value);
      afterDamage(st, attacker, self, value);
      return true;
    } else if (self.armor > 0) {
      if (self.armor + self.hp > value) {
        const overflow = value - self.armor;
        self.armor = 0; self.hp -= overflow;
      } else {
        value = self.armor + self.hp;
        self.armor = 0; self.hp = 0;
      }
      beenAttacked(st, self, attacker, value);
      if (self.hp === 0) killChain(st, attacker, self);
      afterDamage(st, attacker, self, value);
      return true;
    } else {
      if (self.hp < value) value = self.hp;
      self.hp -= value;
      beenAttacked(st, self, attacker, value);
      afterDamage(st, attacker, self, value);
      if (self.hp === 0) killChain(st, attacker, self);
      return true;
    }
  }

  function killChain(st, attacker, victim) {
    logf(st, `${zh(attacker.owner)} ${attacker.name} 斬殺 ${zh(victim.owner)} ${victim.name}`);
    onKilled(st, attacker, victim);
    // 被擊殺方效果 (been_killed)
    if (victim.name === "LUCKYBLOCK") {
      luckyEffects(st, attacker, {});
      for (const c of alive(st.players[attacker.owner] ? st.players[attacker.owner].onBoard : [])) {
        if (c.name === "APTG") c.armor += 1;
      }
    }
  }

  /* =====================================================================
   * 攻擊 (base.py launch_attack + 攻擊佇列)
   * =================================================================== */
  function launchAttack(st, attacker, types, customTargets, ignoreNumbness, useAbility) {
    types = types || attacker.attackTypes;
    customTargets = customTargets || [];
    const isOuter = !st.attackDraining;
    if (isOuter) st.attackDraining = true;
    try {
      const result = launchAttackImpl(st, attacker, types, customTargets, ignoreNumbness, useAbility !== false);
      if (isOuter) {
        // 佇列上限: 防止綠色幸運連鎖 (免費攻擊→殺方塊→好運→再攻擊) 超臨界發散
        let drained = 0;
        while (st.pendingAttacks.length && drained++ < 100) {
          const req = st.pendingAttacks.shift();
          if (req.attacker.hp <= 0) continue;
          const at = req.types || req.attacker.attackTypes;
          if (!at) continue;
          launchAttackImpl(st, req.attacker, at, [], false, true);
        }
        if (st.pendingAttacks.length) {
          st.pendingAttacks.length = 0;
          logf(st, "(連鎖攻擊達上限,佇列截斷)");
        }
      }
      return result;
    } finally {
      if (isOuter) st.attackDraining = false;
    }
  }

  function launchAttackImpl(st, attacker, types, customTargets, ignoreNumbness, useAbility) {
    if (!ignoreNumbness && (attacker.numbness || !types)) return false;
    const enemies = alive(sideCards(st, attacker.owner, true));
    const targets = customTargets.length ? customTargets : detection(attacker, types, enemies, st);
    if (!targets.length) return false;
    for (const t of targets) {
      damageCalculate(st, t, attacker.dmg, attacker, useAbility);
    }
    recycleDead(st);
    return true;
  }

  /* ---------- 死亡回收 (player.recycle_cards) ---------- */
  function recycleDead(st) {
    for (const p of ["player1", "player2"]) {
      const pl = st.players[p];
      const dead = pl.onBoard.filter(c => c.hp <= 0);
      for (const c of dead) {
        pl.discard.push(c.name);
        logf(st, `${zh(p)} ${c.name} 死亡 → 棄牌堆`);
      }
      pl.onBoard = pl.onBoard.filter(c => c.hp > 0);
    }
    st.neutral = st.neutral.filter(c => c.hp > 0);
    // card_to_draw 立即結算 (player.logic_update)
    for (const p of ["player1", "player2"]) {
      while (st.cardToDraw[p] > 0) { st.cardToDraw[p] -= 1; drawCard(st, p); }
    }
  }

  /* ---------- 抽牌 (player.draw_card) ---------- */
  function drawCard(st, owner) {
    const pl = st.players[owner];
    // 鏡像模式: 依真實對局日誌的抽牌順序 (消除洗牌隨機性)
    if (st.drawScript && st.drawScript[owner] && st.drawScript[owner].length) {
      const name = st.drawScript[owner].shift();
      if (!pl.drawPile.length && pl.discard.length) {
        pl.drawPile = pl.discard.slice();
        pl.discard = [];
      }
      const i = pl.drawPile.lastIndexOf(name);
      if (i >= 0) pl.drawPile.splice(i, 1);
      else pl.drawPile.pop();
      pl.hand.push(name);
      return;
    }
    if (!pl.drawPile.length) {
      if (pl.discard.length) {
        st.rng.shuffle(pl.discard);
        pl.drawPile = pl.discard.slice();
        pl.discard = [];
      } else return;
    }
    const name = pl.drawPile.pop();
    pl.hand.push(name);
  }

  /* =====================================================================
   * 玩家行動 API (AI 呼叫)
   * =================================================================== */
  function playCard(st, owner, handIndex, x, y) {
    const pl = st.players[owner];
    if (handIndex < 0 || handIndex >= pl.hand.length) return false;
    const name = pl.hand[handIndex];
    if (name === "MOVEO") {       // 魔法牌: +1 移動次數,本回合限定
      st.movings[owner] += 1;
      pl.hand.splice(handIndex, 1);
      logf(st, `${zh(owner)} 使用 MOVEO (+1 移動)`);
      return true;
    }
    if (name === "MOVE") {        // 魔法牌: +1 移動次數,用後進棄牌堆
      st.movings[owner] += 1;
      pl.discard.push(pl.hand.splice(handIndex, 1)[0]);
      logf(st, `${zh(owner)} 使用 移動魔法 (+1 移動)`);
      return true;
    }
    if (name === "HEAL") {        // 魔法牌: +1 回血次數
      st.heals[owner] += 1;
      pl.discard.push(pl.hand.splice(handIndex, 1)[0]);
      logf(st, `${zh(owner)} 使用 回血魔法 (+1 回血)`);
      return true;
    }
    if (name === "CUBES") {       // 魔法牌: +2 可放方塊
      st.cubes[owner] += 2;
      pl.discard.push(pl.hand.splice(handIndex, 1)[0]);
      logf(st, `${zh(owner)} 使用 方塊魔法 (+2 方塊)`);
      return true;
    }
    if (!validPos(x, y) || cellOccupied(st, x, y)) return false;
    const card = makeCard(name, owner, x, y);
    onDeploy(st, card);            // spawn_card: deploy 先於上場
    pl.onBoard.push(card);
    pl.hand.splice(handIndex, 1);
    logf(st, `${zh(owner)} 放置 ${name} 於 (${x},${y})`);
    recycleDead(st);
    return true;
  }

  function validPos(x, y) { return x >= 0 && x < W && y >= 0 && y < H; }

  /* 回血行動 (player.heal_card): 對 (x,y) 的我方單位回 6 血,溢出 2:1 轉護甲 */
  function healAt(st, owner, x, y) {
    if (st.heals[owner] <= 0) return false;
    const card = alive(st.players[owner].onBoard).find(c => c.x === x && c.y === y);
    if (!card) return false;
    healCard(card, 6);
    st.heals[owner] -= 1;
    logf(st, `${zh(owner)} 回血 ${card.name} (+6)`);
    return true;
  }

  /* 放置中立方塊 (player.spawn_cube) */
  function spawnCube(st, owner, x, y) {
    if (st.cubes[owner] <= 0) return false;
    if (!validPos(x, y) || cellOccupied(st, x, y)) return false;
    st.neutral.push(makeCard("CUBE", "neutral", x, y));
    st.cubes[owner] -= 1;
    logf(st, `${zh(owner)} 放置方塊於 (${x},${y})`);
    return true;
  }

  function attackWith(st, owner, card, customTargets) {
    if (st.attacks[owner] <= 0) return false;
    if (card.owner !== owner || card.hp <= 0) return false;
    if (card.name === "APTG") return false;   // APTG 的 attack() 永遠 return False
    logf(st, `${zh(owner)} ${card.name}(${card.x},${card.y}) 發動攻擊`);
    const ok = launchAttack(st, card, null, customTargets || [], false, true);
    if (ok) {
      st.attacks[owner] -= 1;
      // 橘色: 攻擊後獲得移動 (card_orange.py attack 覆寫)
      if (["ADCO", "HFO", "LFO"].includes(card.name) && card.hp > 0) card.moving = true;
    } else st.log.pop();
    return ok;
  }

  /* =====================================================================
   * 移動系統 (base.py Card.move + card_orange.py)
   * =================================================================== */
  function spendMoving(st, owner, card) {
    // 消耗 1 點移動次數讓單位進入移動狀態 (player.move_card 分支1)
    if (st.movings[owner] <= 0) return false;
    if (card.owner !== owner || card.hp <= 0 || card.numbness || card.moving) return false;
    card.moving = true;
    st.movings[owner] -= 1;
    return true;
  }

  function moveCard(st, card, x, y) {
    if (!card.moving || card.hp <= 0) return false;
    if (!validPos(x, y) || cellOccupied(st, x, y)) { card.moving = false; return false; }
    const dx = Math.abs(card.x - x), dy = Math.abs(card.y - y);
    if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) { card.moving = false; return false; }
    const fromX = card.x, fromY = card.y;
    card.x = x; card.y = y;
    card.moving = false;
    logf(st, `${zh(card.owner)} ${card.name} 移動 (${fromX},${fromY}) → (${x},${y})`);
    afterMovement(st, card);
    for (const c of allCards(st)) moveBroadcast(st, c, card);
    recycleDead(st);
    return true;
  }

  function afterMovement(st, card) {
    switch (card.name) {
      case "ADCO":   // 移動後自動再攻擊 (免費)
        launchAttack(st, card, null, [], false, true);
        break;
      case "HFO":
        card.extraDamage += 1;
        card.anger = true;
        logf(st, `HFO 移動 → 攻擊 +1 (本回合)`);
        break;
      case "LFO": {
        const opps = alive(st.players[opponentOf(card.owner)].onBoard);
        for (const t of detection(card, "nearest", opps, st)) {
          damageCalculate(st, t, card.dmg, card, true);
        }
        break;
      }
      case "ASSO":
        card.anger = true;
        logf(st, `ASSO 移動 → 進入狂暴`);
        break;
      case "APTO": {
        card.armor += 1;
        const v = Math.floor(card.armor / 2);
        if (v > 0) {
          card.dmg += v;
          card.armor = card.armor % 2;
          logf(st, `APTO 移動 → 護盾轉攻擊 +${v}`);
        }
        break;
      }
    }
  }

  function moveBroadcast(st, self, mover) {
    if (self.hp <= 0) return;
    switch (self.name) {
      case "TANKP":
        if (mover.owner !== self.owner && mover.owner !== "neutral") {
          damageCalculate(st, mover, 2, self, true);
          logf(st, `TANKP 懲罰移動 → ${mover.name} -2 血`);
        }
        break;
      case "APTO":
        if (mover.owner === self.owner && mover !== self) {
          mover.armor += 1;
          self.armor += 1;
        }
        break;
      case "SPO":
        if (mover.owner === self.owner) {
          const opps = alive(sideCards(st, self.owner, true));
          for (const t of detection(self, "farthest", opps, st)) {
            damageCalculate(st, t, 3, self, true);
          }
        }
        break;
    }
  }

  function endTurn(st) {
    const owner = currentPlayer(st);
    st.turnNumber += 1;
    const pl = st.players[owner];
    // 回合結束清理: MOVEO 消失、各計數歸零 (player.turn_end)
    pl.hand = pl.hand.filter(n => n !== "MOVEO");
    st.movings[owner] = 0;
    st.heals[owner] = 0;
    st.cubes[owner] = 0;
    // settle: 未麻痺者得分,麻痺者清除麻痺 (base.py on_settle)
    let pts = 0;
    for (const c of pl.onBoard) {
      c.moving = false;
      // HFO/ASSO 結算清除 (card_orange.py on_settle)
      if (c.name === "HFO") { c.extraDamage = 0; c.anger = false; }
      if (c.name === "ASSO") c.anger = false;
      if (c.numbness) { c.numbness = false; }
      else pts += (c.name === "SPW" ? 2 : 1);
    }
    if (owner === "player1") st.score -= pts; else st.score += pts;
    logf(st, `${zh(owner)} 回合結束,結算 +${pts} 分 (總分 ${st.score})`);
    st.scoreHistory.push(st.score);

    if (Math.abs(st.score) >= 10) {
      st.winner = st.score < 0 ? "player1" : "player2";
      logf(st, `★ ${zh(st.winner)} 達成 10 分差獲勝!`);
      return;
    }
    if (st.turnNumber >= st.maxTurns) {
      st.winner = st.score < 0 ? "player1" : (st.score > 0 ? "player2" : "tie");
      logf(st, `達回合上限,依分數判定: ${st.winner === "tie" ? "平手" : zh(st.winner)}`);
      return;
    }
    // 對手回合開始 (player.turn_start)
    const next = currentPlayer(st);
    drawCard(st, next);
    st.attacks[next] += 1;
    for (const c of st.players[next].onBoard.slice()) { c.moving = false; onRefresh(st, c); }
    recycleDead(st);
    logf(st, `—— ${zh(next)} 的回合 (第 ${Math.floor(st.turnNumber / 2) + 1} 輪) ——`);
  }

  function zh(p) { return p === "player1" ? "玩家1" : p === "player2" ? "玩家2" : p; }

  /* ---------- 狀態複製 (AI 一步模擬用) ---------- */
  function cloneState(st) {
    const cl = {
      rng: makeRng(0),
      turnNumber: st.turnNumber,
      score: st.score,
      winner: st.winner,
      players: {},
      neutral: st.neutral.map(c => ({ ...c })),
      attacks: { ...st.attacks },
      tokens: { ...st.tokens },
      totem: { ...st.totem },
      luck: { ...st.luck },
      movings: { ...st.movings },
      heals: { ...st.heals },
      cubes: { ...st.cubes },
      drawScript: null,          // 搜索分支不得消耗鏡像抽牌腳本
      cardToDraw: { ...st.cardToDraw },
      pendingAttacks: [],
      attackDraining: false,
      log: [],
      record: null,             // 模擬分支不錄影
      maxTurns: st.maxTurns,
      scoreHistory: [],
      deckOf: st.deckOf,
      deckLists: st.deckLists,
    };
    cl.rng.setState(st.rng.getState());
    for (const p of ["player1", "player2"]) {
      const pl = st.players[p];
      cl.players[p] = {
        name: p,
        deck: pl.deck.slice(), hand: pl.hand.slice(),
        drawPile: pl.drawPile.slice(), discard: pl.discard.slice(),
        onBoard: pl.onBoard.map(c => ({ ...c })),
      };
    }
    const byUid = {};
    for (const c of allCards(cl)) byUid[c.uid] = c;
    cl.pendingAttacks = st.pendingAttacks
      .map(r => ({ attacker: byUid[r.attacker.uid], types: r.types }))
      .filter(r => r.attacker);
    return cl;
  }

  /* ---------- 完整狀態序列化 (實戰助手橋接用) ---------- */
  function dumpState(st) {
    const dumpCard = (c) => ({ ...c });
    return {
      turnNumber: st.turnNumber,
      score: st.score,
      winner: st.winner,
      rngState: st.rng.getState(),
      players: {
        player1: {
          deck: st.players.player1.deck.slice(), hand: st.players.player1.hand.slice(),
          drawPile: st.players.player1.drawPile.slice(), discard: st.players.player1.discard.slice(),
          onBoard: st.players.player1.onBoard.map(dumpCard),
        },
        player2: {
          deck: st.players.player2.deck.slice(), hand: st.players.player2.hand.slice(),
          drawPile: st.players.player2.drawPile.slice(), discard: st.players.player2.discard.slice(),
          onBoard: st.players.player2.onBoard.map(dumpCard),
        },
      },
      neutral: st.neutral.map(dumpCard),
      attacks: { ...st.attacks }, tokens: { ...st.tokens }, totem: { ...st.totem },
      luck: { ...st.luck }, movings: { ...st.movings }, heals: { ...st.heals }, cubes: { ...st.cubes },
      deckLists: st.deckLists, deckOf: st.deckOf,
      maxTurns: st.maxTurns,
    };
  }

  function loadState(dump) {
    const st = {
      rng: makeRng(1),
      turnNumber: dump.turnNumber,
      score: dump.score,
      winner: dump.winner || null,
      players: {},
      neutral: dump.neutral.map(c => ({ ...c })),
      attacks: { ...dump.attacks }, tokens: { ...dump.tokens }, totem: { ...dump.totem },
      luck: { ...dump.luck }, movings: { ...dump.movings },
      heals: { ...(dump.heals || { player1: 0, player2: 0 }) },
      cubes: { ...(dump.cubes || { player1: 0, player2: 0 }) },
      drawScript: null,
      cardToDraw: { player1: 0, player2: 0 },
      pendingAttacks: [],
      attackDraining: false,
      log: [],
      record: null,
      maxTurns: dump.maxTurns || 80,
      scoreHistory: [],
      deckOf: dump.deckOf || { player1: "custom", player2: "custom" },
      deckLists: dump.deckLists,
    };
    if (dump.rngState !== undefined) st.rng.setState(dump.rngState);
    for (const p of ["player1", "player2"]) {
      const d = dump.players[p];
      st.players[p] = {
        name: p,
        deck: d.deck.slice(), hand: d.hand.slice(),
        drawPile: d.drawPile.slice(), discard: d.discard.slice(),
        onBoard: d.onBoard.map(c => ({ ...c })),
      };
    }
    // 修正 uid 計數器,避免後續生成卡與既有 uid 衝突
    let maxUid = 0;
    for (const c of allCards(st)) if (typeof c.uid === "number" && c.uid > maxUid) maxUid = c.uid;
    if (maxUid >= UID) UID = maxUid + 1;
    return st;
  }

  /* ---------- 快照 (觀戰回放用) ---------- */
  function snapshot(st, label) {
    if (!st.record) return;
    st.record.push({
      label,
      turnNumber: st.turnNumber,
      current: currentPlayer(st),
      score: st.score,
      winner: st.winner,
      attacks: { ...st.attacks },
      tokens: { ...st.tokens },
      totem: { ...st.totem },
      luck: { ...st.luck },
      movings: { ...st.movings },
      hands: {
        player1: st.players.player1.hand.slice(),
        player2: st.players.player2.hand.slice(),
      },
      piles: {
        player1: { draw: st.players.player1.drawPile.length, discard: st.players.player1.discard.length },
        player2: { draw: st.players.player2.drawPile.length, discard: st.players.player2.discard.length },
      },
      board: allCards(st).filter(c => c.hp > 0).map(c => ({
        uid: c.uid, name: c.name, job: c.job, color: c.color, owner: c.owner,
        x: c.x, y: c.y, hp: c.hp, maxHp: c.maxHp, dmg: c.dmg, armor: c.armor, numb: c.numbness,
        moving: c.moving,
      })),
      log: st.log.splice(0),
    });
  }

  root.ABEngine = {
    makeRng, makeCard, createState, cloneState, currentPlayer, opponentOf,
    detection, detectionCandidates, launchAttack, damageCalculate,
    playCard, attackWith, endTurn, snapshot, recycleDead,
    moveCard, spendMoving, spawnLuckyBlock, healAt, spawnCube, drawCard,
    dumpState, loadState,
    cellOccupied, allCards, sideCards, alive, validPos,
    STATS, ATTACK_TYPES, jobOf, colorOf, W, H, zh,
  };
})(typeof module !== "undefined" ? module.exports : (window.AB = window.AB || {}));
