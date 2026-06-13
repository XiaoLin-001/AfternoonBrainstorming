/* =====================================================================
 * 戰役 AI (使用者的 campaign/ 決策系統之 JS 移植)
 * 逐函數對照原始碼:
 *   campaign/ai_query.py      → Q.*
 *   campaign/ai_evaluator.py  → EV.*
 *   campaign/ai_strategies/*  → STRATEGIES
 *   campaign/ai_controller.py → takeTurn (tick 迴圈摺疊為同步回合)
 *   campaign/boss_config.py   → 關卡增益 (可選)
 *   config/campaign_setting.json → SETTINGS
 * ===================================================================== */
(function (root) {
  "use strict";
  const E = (typeof module !== "undefined") ? require("./engine.js").ABEngine
                                            : window.AB.ABEngine;

  /* ---------- campaign_setting.json ---------- */
  const SETTINGS = {
    thresholds: { placement_min_score: 1.0, attack_min_score: 15.0, lethal_score_threshold: 100.0 },
    scoring: { kill_bonus_base: 100.0, kill_bonus_per_threat: 10.0, score_income_multiplier: 8.0, hand_threat_value: { ASS: 20.0 } },
    threat_model: { ass_threat_damage: 5, incoming_kill_penalty: 30.0, incoming_chip_penalty_per_damage: 1.5 },
    faction_overrides: {
      white: { attack_min_score: 10.0 },
      red: { attack_min_score: 12.0 },
      blue: { attack_min_score: 13.0 },
      orange: { attack_min_score: 12.0 },
      boss: { attack_min_score: 13.0 },
    },
  };

  /* ---------- ai_decks.py ---------- */
  const STAGE_AI_DECKS = {
    white:  ["ADCW","ADCW","APW","TANKW","TANKW","HFW","HFW","LFW","ASSW","ASSW","APTW","SPW"],
    red:    ["ADCR","ADCR","APR","TANKR","TANKR","HFR","HFR","LFR","LFR","ASSR","ASSR","SPR"],
    blue:   ["ADCB","ADCB","APB","TANKB","TANKB","HFB","LFB","LFB","ASSB","ASSB","APTB","SPB"],
    green:  ["ADCG","ADCG","APG","TANKG","TANKG","HFG","HFG","LFG","LFG","ASSG","APTG","SPG"],
    orange: ["ADCO","ADCO","APO","TANKO","TANKO","HFO","HFO","LFO","LFO","ASSO","ASSO","SPO"],
    boss:   ["ADCW","ADCR","TANKB","TANKW","LFO","LFR","ASSB","ASSO","HFO","HFR","SPR","APTB"],
  };
  const STAGE_LABELS = {
    white: "戰役·白色(教學)", red: "戰役·紅色(滾傷)", blue: "戰役·藍色(藍球)",
    green: "戰役·綠色(幸運)", orange: "戰役·橘色(機動)", boss: "戰役·Boss(混編)",
  };

  const JOBS_ATTACK_ON_DEPLOY = new Set(["ASS"]);
  const NON_ATTACKING_CARDS = new Set(["APTG"]);
  const PRIORITY_TARGET_JOBS = new Set(["ADC", "SP"]);
  const SQUISHY_DPS_JOBS = new Set(["ADC", "AP", "SP"]);
  const ASS_THREAT_DAMAGE = SETTINGS.threat_model.ass_threat_damage;
  const MAGIC = new Set(["HEAL", "MOVE", "MOVEO", "CUBES"]);

  /* =====================================================================
   * ai_query.py
   * =================================================================== */
  const Q = {};

  Q.emptyPositions = (st) => {
    const out = [];
    for (let x = 0; x < E.W; x++) for (let y = 0; y < E.H; y++) {
      if (!E.cellOccupied(st, x, y)) out.push([x, y]);
    }
    return out;
  };
  Q.isCorner = (x, y) => (x === 0 || x === E.W - 1) && (y === 0 || y === E.H - 1);
  Q.isEdge = (x, y) => ((x === 0 || x === E.W - 1) || (y === 0 || y === E.H - 1)) && !Q.isCorner(x, y);
  Q.positionSafety = (x, y) => Q.isCorner(x, y) ? 3.0 : (Q.isEdge(x, y) ? 2.0 : 1.0);
  Q.manhattan = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);
  Q.enemyCards = (st, owner) => E.alive(st.players[E.opponentOf(owner)].onBoard);
  Q.friendlyCards = (st, owner) => E.alive(st.players[owner].onBoard);

  /* 含中立單位 (方塊/幸運方塊可被攻擊) — 對應 get_side_cards(opponent=True) */
  Q.attackTargetsFromPos = (st, owner, x, y, attackTypes) => {
    const candidates = E.alive(E.sideCards(st, owner, true));
    if (!candidates.length || !attackTypes) return [];
    const hits = [];
    for (const at of attackTypes.split(" ")) {
      if (at === "small_cross") {
        for (const c of candidates) if (Q.manhattan(c.x, c.y, x, y) === 1) hits.push(c);
      } else if (at === "large_cross") {
        for (const c of candidates) {
          if ((c.y === y || c.x === x) && !(c.x === x && c.y === y)) hits.push(c);
        }
      } else if (at === "small_x") {
        for (const c of candidates) if (Math.abs(c.x - x) === 1 && Math.abs(c.y - y) === 1) hits.push(c);
      } else if (at === "nearest" || at === "farthest") {
        const sorted = candidates.slice().sort((a, b) => {
          const da = Q.manhattan(a.x, a.y, x, y), db = Q.manhattan(b.x, b.y, x, y);
          return at === "nearest" ? da - db : db - da;
        });
        if (sorted.length) {
          const best = Q.manhattan(sorted[0].x, sorted[0].y, x, y);
          for (const c of sorted) if (Q.manhattan(c.x, c.y, x, y) === best) hits.push(c);
        }
      }
    }
    const seen = new Set(); const out = [];
    for (const c of hits) { if (!seen.has(c.uid)) { seen.add(c.uid); out.push(c); } }
    return out;
  };
  Q.attackTargetsAt = (st, card) => Q.attackTargetsFromPos(st, card.owner, card.x, card.y, card.attackTypes);

  Q.nearestEnemyDistance = (st, owner, x, y) => {
    const enemies = Q.enemyCards(st, owner);
    if (!enemies.length) return E.W + E.H;
    return Math.min(...enemies.map(e => Q.manhattan(x, y, e.x, e.y)));
  };

  Q.attackCoverageCells = (x, y, attackTypes) => {
    if (!attackTypes) return 0;
    const cells = new Set();
    for (const at of attackTypes.split(" ")) {
      if (at === "small_cross") {
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < E.W && ny >= 0 && ny < E.H) cells.add(nx + "," + ny);
        }
      } else if (at === "small_x") {
        for (const [dx, dy] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < E.W && ny >= 0 && ny < E.H) cells.add(nx + "," + ny);
        }
      } else if (at === "large_cross") {
        for (let i = 0; i < E.W; i++) if (i !== x) cells.add(i + "," + y);
        for (let j = 0; j < E.H; j++) if (j !== y) cells.add(x + "," + j);
      }
    }
    return cells.size;
  };

  Q.isPlayableUnitCard = (n) => !MAGIC.has(n);

  Q.unitsWithPendingMove = (st, owner) =>
    st.players[owner].onBoard.filter(c => c.moving && c.hp > 0);

  Q.moveDestinationsFor = (st, card) => {
    const out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nx = card.x + dx, ny = card.y + dy;
      if (E.validPos(nx, ny) && !E.cellOccupied(st, nx, ny)) out.push([nx, ny]);
    }
    return out;
  };

  Q.attackerWouldHitPosition = (st, attacker, tx, ty, targetOwner) => {
    const ax = attacker.x, ay = attacker.y;
    if (!attacker.attackTypes) return false;
    for (const at of attacker.attackTypes.split(" ")) {
      if (at === "small_cross" && Q.manhattan(ax, ay, tx, ty) === 1) return true;
      if (at === "large_cross" && (ax === tx || ay === ty) && !(ax === tx && ay === ty)) return true;
      if (at === "small_x" && Math.abs(ax - tx) === 1 && Math.abs(ay - ty) === 1) return true;
      if (at === "nearest" || at === "farthest") {
        const friendlies = Q.friendlyCards(st, targetOwner);
        const dNew = Q.manhattan(ax, ay, tx, ty);
        const dOthers = friendlies.map(f => Q.manhattan(ax, ay, f.x, f.y));
        if (at === "nearest" && (!dOthers.length || dNew <= Math.min(...dOthers))) return true;
        if (at === "farthest" && (!dOthers.length || dNew >= Math.max(...dOthers))) return true;
      }
    }
    return false;
  };

  /* HFB/DKG 等動態加成 (python 由 update() 每幀寫入 extra_damage) */
  function dynExtra(st, c) {
    if (c.name === "HFB") return st.tokens[c.owner];
    if (c.name === "ADCDKG") return Math.floor(st.totem[c.owner] / 4);
    if (c.name === "APTDKG") return Math.floor(st.totem[c.owner] / 2);
    return 0;
  }
  function effDmg(st, c) { return c.dmg + c.extraDamage + dynExtra(st, c); }

  Q.incomingDamageAtPosition = (st, owner, x, y) => {
    const opp = E.opponentOf(owner);
    const available = st.attacks[opp] || 0;
    if (available <= 0) return 0;
    const threats = [];
    for (const enemy of Q.enemyCards(st, owner)) {
      if (enemy.numbness) continue;
      if (Q.attackerWouldHitPosition(st, enemy, x, y, owner)) threats.push(effDmg(st, enemy));
    }
    threats.sort((a, b) => b - a);
    return threats.slice(0, available).reduce((s, v) => s + v, 0);
  };

  Q.cellsThreateningCard = (st, card) => {
    const effective = ASS_THREAT_DAMAGE - Math.max(0, card.armor);
    if (card.hp > effective) return [];
    const spots = [];
    for (const [x, y] of Q.emptyPositions(st)) {
      if (Math.abs(card.x - x) === 1 && Math.abs(card.y - y) === 1) spots.push([x, y]);
    }
    return spots;
  };

  /* =====================================================================
   * ai_evaluator.py
   * =================================================================== */
  const EV = {};
  const _S = SETTINGS.scoring;

  EV.cardBaseStats = (name) => {
    const s = E.STATS[name];
    return s ? [s.hp, s.dmg] : [0, 0];
  };

  EV.estimateScorePerTurn = (name) => {
    const job = E.jobOf(name);
    if (["CUBE", "CUBES", "HEAL", "MOVE", "MOVEO", "LUCKYBLOCK"].includes(job)) return 0;
    if (job === "SP") return name === "SPW" ? 2 : 1;   // SPW: extra_score 1
    return 1;
  };
  EV.scoreIncomeBonus = (name) => EV.estimateScorePerTurn(name) * _S.score_income_multiplier;
  EV.attackDenialBonus = (target) => EV.estimateScorePerTurn(target.name) * _S.score_income_multiplier;
  EV.targetPriorityBonus = (target) => PRIORITY_TARGET_JOBS.has(E.jobOf(target.name)) ? 5.0 : 0.0;

  EV.isAngerImmortal = (card) => card.name === "HFR" && !!card.anger;

  EV.followupKillBonus = (st, attacker, target, chipDamage) => {
    if ((st.attacks[attacker.owner] || 0) < 2) return 0.0;
    const remaining = target.hp - chipDamage;
    if (remaining <= 0) return 0.0;
    const armor = Math.max(0, target.armor);
    for (const other of st.players[attacker.owner].onBoard) {
      if (other === attacker || other.numbness || other.hp <= 0) continue;
      if (NON_ATTACKING_CARDS.has(other.name)) continue;
      if (!Q.attackTargetsAt(st, other).some(t => t.uid === target.uid)) continue;
      if (remaining + armor <= effDmg(st, other)) return 15.0 + target.dmg * 2.0;
    }
    return 0.0;
  };

  EV.defensivePlacementBonus = (st, position, owner) => {
    let sum = 0; let any = false;
    for (const f of Q.friendlyCards(st, owner)) {
      const cells = Q.cellsThreateningCard(st, f);
      if (cells.some(([x, y]) => x === position[0] && y === position[1])) {
        sum += f.dmg * 6.0 + f.hp * 1.5;
        any = true;
      }
    }
    return any ? sum : 0.0;
  };

  EV.threatPlacementBonus = (st, cardName, position, owner) => {
    const job = E.jobOf(cardName);
    const attackTypes = E.ATTACK_TYPES[job] || "";
    if (!attackTypes) return 0.0;
    const [, damage] = EV.cardBaseStats(cardName);
    if (damage <= 0) return 0.0;
    const targets = Q.attackTargetsFromPos(st, owner, position[0], position[1], attackTypes);
    if (!targets.length) return 0.0;
    let total = targets.reduce((s, t) => s + Math.min(damage, t.hp) * 0.3 + t.dmg * 0.5, 0);
    if (!JOBS_ATTACK_ON_DEPLOY.has(job)) total *= 0.6;
    return total;
  };

  EV.incomingDamagePenalty = (st, cardName, position, owner) => {
    const incoming = Q.incomingDamageAtPosition(st, owner, position[0], position[1]);
    if (incoming <= 0) return 0.0;
    const [health] = EV.cardBaseStats(cardName);
    if (health <= 0) return 0.0;
    if (incoming >= health) return -SETTINGS.threat_model.incoming_kill_penalty;
    return -incoming * SETTINGS.threat_model.incoming_chip_penalty_per_damage;
  };

  EV.handThreatPenalty = (cardName) => -(_S.hand_threat_value[E.jobOf(cardName)] || 0.0);

  EV.futureAssThreatPenalty = (st, cardName, position) => {
    const [health] = EV.cardBaseStats(cardName);
    if (health <= 0 || health > ASS_THREAT_DAMAGE) return 0.0;
    const [x, y] = position;
    let vulnerable = 0;
    for (const [dx, dy] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (E.validPos(nx, ny) && !E.cellOccupied(st, nx, ny)) vulnerable++;
    }
    if (!vulnerable) return 0.0;
    return -vulnerable * (3.0 + EV.estimateScorePerTurn(cardName) * 1.5);
  };

  EV.protectionBonus = (st, cardName, owner) => {
    if (!SQUISHY_DPS_JOBS.has(E.jobOf(cardName))) return 0.0;
    const hasFrontLine = st.players[owner].onBoard.some(c => c.hp > ASS_THREAT_DAMAGE);
    return hasFrontLine ? 4.0 : -12.0;
  };

  EV.reachBonus = (cardName, position) => {
    const job = E.jobOf(cardName);
    const attackTypes = E.ATTACK_TYPES[job] || "";
    if (!attackTypes) return 0.0;
    return Q.attackCoverageCells(position[0], position[1], attackTypes) * 0.8;
  };

  EV.lethalPlacementBonus = (st, cardName, position, owner) => {
    const job = E.jobOf(cardName);
    if (!JOBS_ATTACK_ON_DEPLOY.has(job)) return 0.0;
    const [, damage] = EV.cardBaseStats(cardName);
    if (damage <= 0) return 0.0;
    const attackTypes = E.ATTACK_TYPES[job] || "";
    if (!attackTypes) return 0.0;
    const targets = Q.attackTargetsFromPos(st, owner, position[0], position[1], attackTypes);
    let best = 0.0;
    for (const target of targets) {
      if (EV.isAngerImmortal(target)) continue;
      const effective = damage - Math.max(0, target.armor);
      if (effective <= 0) continue;
      if (target.hp <= effective) {
        const bonus = _S.kill_bonus_base + target.dmg * _S.kill_bonus_per_threat +
                      EV.attackDenialBonus(target) + EV.targetPriorityBonus(target);
        if (bonus > best) best = bonus;
      }
    }
    return best;
  };

  EV.evaluatePlacement = (st, cardName, position, owner) => {
    const [x, y] = position;
    if (!E.validPos(x, y) || E.cellOccupied(st, x, y)) return -1000.0;
    const [health, damage] = EV.cardBaseStats(cardName);
    let score = health * 0.5 + damage * 1.5;

    const safety = Q.positionSafety(x, y);
    const job = E.jobOf(cardName);
    if (job === "SP") score += safety * 4.0;
    else if (job === "TANK" || job === "HF") score += safety * 1.0;
    else if (job === "ASS") score += safety * 0.5;
    else score += safety * 2.0;

    const dist = Q.nearestEnemyDistance(st, owner, x, y);
    if ((job === "ASS" || job === "LF") && dist <= 2) score += 2.0;
    if ((job === "TANK" || job === "HF") && dist <= 1) score += 3.0;
    if (job === "SP" && dist <= 2) score -= 5.0;

    score += EV.lethalPlacementBonus(st, cardName, position, owner);
    score += EV.defensivePlacementBonus(st, position, owner);
    score += EV.threatPlacementBonus(st, cardName, position, owner);
    score += EV.incomingDamagePenalty(st, cardName, position, owner);
    score += EV.handThreatPenalty(cardName);
    score += EV.scoreIncomeBonus(cardName);
    score += EV.reachBonus(cardName, position);
    score += EV.futureAssThreatPenalty(st, cardName, position);
    score += EV.protectionBonus(st, cardName, owner);
    return score;
  };

  EV.scoreMoveDestination = (st, card, dest) => {
    const [dx, dy] = dest;
    const targets = Q.attackTargetsFromPos(st, card.owner, dx, dy, card.attackTypes);
    if (card.name === "ADCO") {
      return targets.reduce((s, t) => s + Math.min(card.dmg, t.hp) * 2.0, 0);
    }
    if (card.name === "LFO") {
      const enemies = Q.enemyCards(st, card.owner);
      if (!enemies.length) return 0.0;
      const nearest = Math.min(...enemies.map(e => Q.manhattan(dx, dy, e.x, e.y)));
      return 6.0 - nearest;
    }
    if (card.name === "HFO") {
      const projected = card.dmg + card.extraDamage + 1;
      return Q.positionSafety(dx, dy) + targets.length * projected * 0.6;
    }
    if (card.name === "ASSO") {
      for (const t of targets) {
        const effective = card.dmg - Math.max(0, t.armor);
        if (effective > 0 && t.hp <= effective) return 20.0 + t.dmg * 2.0;
      }
      return targets.length * 2.0;
    }
    return targets.length * 1.5;
  };

  EV.evaluateAttack = (st, attacker) => {
    if (attacker.numbness) return [-1.0, null];
    if (NON_ATTACKING_CARDS.has(attacker.name)) return [-1.0, null];
    const targets = Q.attackTargetsAt(st, attacker);
    if (!targets.length) return [-1.0, null];

    let bestScore = -Infinity, bestTarget = null;
    const attackerImmortal = EV.isAngerImmortal(attacker);
    for (const target of targets) {
      let s = 0.0;
      const effective = effDmg(st, attacker);
      if (target.armor >= effective) {
        s += 5.0;
      } else if (target.hp <= effective - Math.max(0, target.armor) && !EV.isAngerImmortal(target)) {
        s += 100.0 + target.dmg * 10.0 + EV.attackDenialBonus(target);
      } else {
        s += Math.min(effective, target.hp) * 2.0;
        const followup = EV.followupKillBonus(st, attacker, target, effective);
        s += followup;
        if (followup === 0.0) s -= 5.0;   // WASTED_CHIP_PENALTY
      }
      s += target.dmg * 3.0;
      s += EV.targetPriorityBonus(target);
      if (target.dmg >= attacker.hp && !target.numbness && !attackerImmortal) s -= 50.0;
      if (target.numbness) s -= 20.0;
      if (s > bestScore) { bestScore = s; bestTarget = target; }
    }
    return [bestScore, bestTarget];
  };

  /* =====================================================================
   * ai_strategies/* — 各派系策略
   * =================================================================== */
  function makeStrategy(stage) {
    const strat = {
      stage,
      placement_min_score: SETTINGS.thresholds.placement_min_score,
      attack_min_score: SETTINGS.thresholds.attack_min_score,
      placementBonus: (st, cardName, pos, owner, base) => base,
      attackBonus: (st, attacker, base) => base,
    };
    const ov = SETTINGS.faction_overrides[stage] || {};
    if (ov.attack_min_score !== undefined) strat.attack_min_score = ov.attack_min_score;

    if (stage === "red") {
      const grown = (c) => Math.max(0, c.dmg - c.originalDmg);
      strat.attackBonus = (st, attacker, base) => {
        let bonus = grown(attacker) * 6.0;
        if (attacker.name === "HFR") { bonus += 8.0; if (attacker.anger) bonus += 20.0; }
        if (attacker.name === "ADCR") bonus += 5.0;
        return base + bonus;
      };
      strat.placementBonus = (st, n, pos, owner, base) => {
        if (n === "LFR") return base + 5.0;
        if (n === "SPR") return base + 4.0;
        if (n === "HFR") return base + 3.0;
        return base;
      };
    }

    if (stage === "blue") {
      const TOKEN_VALUE = 4.0;
      const expectedTokens = (st, attacker) => {
        const targets = Q.attackTargetsAt(st, attacker);
        if (!targets.length) return 0;
        const n = attacker.name;
        if (n === "APB") return targets.length * 2;
        if (n === "LFB") return targets.length;
        const effective = effDmg(st, attacker);
        if (n === "ADCB") return targets.filter(t => t.hp <= effective - Math.max(0, t.armor)).length;
        if (n === "ASSB") return targets.filter(t => t.hp <= effective - Math.max(0, t.armor)).length * 2;
        return 0;
      };
      strat.attackBonus = (st, attacker, base) => {
        const tokens = st.tokens[attacker.owner] || 0;
        let bonus = 0.0;
        if (tokens === 2) bonus += 16.0;
        else if (tokens === 1) bonus += 6.0;
        if (attacker.name === "SPB") bonus += 12.0;
        if (attacker.name === "HFB" && tokens >= 1) {
          let hb = 0.0;
          for (const t of Q.attackTargetsAt(st, attacker)) {
            const effective = (attacker.dmg + tokens) - Math.max(0, t.armor);
            if (effective > 0 && t.hp <= effective) { hb += 20.0; break; }
            hb += Math.min(effective, t.hp) * 1.5;
          }
          bonus += Math.min(hb, 70.0);
        }
        if (attacker.name === "LFB") bonus += Q.attackTargetsAt(st, attacker).length * 4.0;
        if (attacker.name === "ADCB" || attacker.name === "ASSB") bonus += 4.0;
        const expected = expectedTokens(st, attacker);
        bonus += expected * TOKEN_VALUE;
        if (tokens + expected >= 3) {
          const armed = st.players[attacker.owner].onBoard.some(
            c => c.name === "ADCB" && !c.numbness && c.hp > 0);
          if (armed) bonus += 12.0;
        }
        return base + bonus;
      };
      strat.placementBonus = (st, n, pos, owner, base) => {
        const tokens = st.tokens[owner] || 0;
        const [x, y] = pos;
        let bonus = 0.0;
        if (n === "TANKB") {
          const dist = Q.nearestEnemyDistance(st, owner, x, y);
          if (dist <= 1) bonus += 12.0; else if (dist <= 2) bonus += 5.0;
        }
        if (n === "SPB") {
          const myUnits = st.players[owner].onBoard.length + st.players[owner].discard.length;
          const enemies = Q.enemyCards(st, owner);
          if (!enemies.length) bonus -= 20.0;
          else {
            bonus += Math.min(myUnits, enemies.length * 2) * 4.5;
            if (enemies.length >= 3) bonus += 8.0;
            const otherPlayables = st.players[owner].hand.filter(c => c !== "SPB" && Q.isPlayableUnitCard(c)).length;
            bonus -= otherPlayables * 5.0;
          }
        }
        if (n === "ADCB") {
          if (tokens === 2) bonus += 18.0; else if (tokens === 1) bonus += 6.0;
          const engines = st.players[owner].onBoard.filter(
            c => c.hp > 0 && ["APB", "LFB", "ASSB", "TANKB", "APTB"].includes(c.name)).length;
          bonus += engines * 4.0;
        }
        if (n === "HFB") {
          if (tokens === 0) bonus -= 6.0; else if (tokens >= 2) bonus += 10.0;
        }
        if (n === "APB") bonus += 5.0;
        if (n === "LFB") {
          const enemies = Q.enemyCards(st, owner);
          const inRange = Q.attackTargetsFromPos(st, owner, x, y, "small_cross");
          if (inRange.length >= 2) bonus += 8.0;
          else if (enemies.length >= 2) bonus += 2.0;
          else bonus -= 6.0;
        }
        if (n === "APTB") bonus += 3.0;
        return base + bonus;
      };
    }

    if (stage === "green") {
      const luckyBlocks = (st) => st.neutral.filter(c => c.name === "LUCKYBLOCK" && c.hp > 0);
      const adjEmpty = (st, x, y) => {
        let n = 0;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (E.validPos(nx, ny) && !E.cellOccupied(st, nx, ny)) n++;
        }
        return n;
      };
      strat.attackBonus = (st, attacker, base) => {
        const blocks = luckyBlocks(st);
        if (attacker.name === "LFG") {
          for (const b of blocks) {
            if (Q.manhattan(b.x, b.y, attacker.x, attacker.y) === 1) return base + 45.0;
          }
        }
        if (attacker.name === "HFG") {
          for (const b of blocks) {
            const d = Q.manhattan(b.x, b.y, attacker.x, attacker.y);
            if (d === 1 || (Math.abs(b.x - attacker.x) === 1 && Math.abs(b.y - attacker.y) === 1)) return base + 30.0;
          }
        }
        if (attacker.name === "ADCG") {
          let empties = 0;
          for (let x = 0; x < E.W; x++) for (let y = 0; y < E.H; y++) {
            if ((x === attacker.x || y === attacker.y) && !(x === attacker.x && y === attacker.y) &&
                !E.cellOccupied(st, x, y)) empties++;
          }
          if (empties > 0) return base + Math.min(8.0, empties * 2.0);
        }
        return base;
      };
      strat.placementBonus = (st, n, pos, owner, base) => {
        const [x, y] = pos;
        const blocks = luckyBlocks(st);
        if (n === "APTG") return base + adjEmpty(st, x, y) * 8.0 + 6.0;
        if (n === "LFG") {
          const adjBlock = blocks.filter(b => Q.manhattan(b.x, b.y, x, y) === 1).length;
          const adjApt = st.players[owner].onBoard.filter(
            c => c.name === "APTG" && Q.manhattan(c.x, c.y, x, y) === 1).length;
          return base + adjBlock * 18.0 + adjApt * 10.0;
        }
        if (n === "HFG") {
          const adjBlock = blocks.filter(b => Math.max(Math.abs(b.x - x), Math.abs(b.y - y)) === 1).length;
          const adjApt = st.players[owner].onBoard.filter(
            c => c.name === "APTG" && Math.max(Math.abs(c.x - x), Math.abs(c.y - y)) === 1).length;
          return base + adjBlock * 14.0 + adjApt * 8.0;
        }
        if (n === "SPG") return base + Math.min(20.0, (st.luck[owner] || 0) * 0.4);
        return base;
      };
    }

    if (stage === "orange") {
      const moveReachTargets = (st, card) => {
        let best = 0;
        const spots = Q.moveDestinationsFor(st, card).concat([[card.x, card.y]]);
        for (const [dx, dy] of spots) {
          const hits = Q.attackTargetsFromPos(st, card.owner, dx, dy, card.attackTypes).length;
          if (hits > best) best = hits;
        }
        return best;
      };
      strat.attackBonus = (st, attacker, base) => {
        let bonus = 0.0;
        if (attacker.name === "ADCO") {
          bonus += base * 0.4;
          bonus += moveReachTargets(st, attacker) * 2.0;
        } else if (attacker.name === "LFO") {
          bonus += 8.0;
        } else if (attacker.name === "HFO") {
          bonus += 12.0;
          if (attacker.extraDamage > 0) bonus += attacker.extraDamage * 6.0;
          const targets = Q.attackTargetsAt(st, attacker);
          if (targets.length > 1) bonus += (targets.length - 1) * 5.0;
        } else if (attacker.name === "ASSO") {
          bonus += attacker.anger ? 25.0 : 4.0;
        }
        return base + bonus;
      };
      strat.placementBonus = (st, n, pos, owner, base) => {
        const [x, y] = pos;
        let bonus = 0.0;
        if (["ADCO", "LFO", "HFO", "ASSO"].includes(n)) {
          const cx = (E.W - 1) / 2.0, cy = (E.H - 1) / 2.0;
          const openness = 4.0 - (Math.abs(x - cx) + Math.abs(y - cy));
          bonus += Math.max(0.0, openness) * 2.0;
        }
        if (n === "TANKO") {
          if (Q.nearestEnemyDistance(st, owner, x, y) <= 1) bonus += 8.0;
        }
        if (n === "SPO") {
          const movers = st.players[owner].onBoard.filter(
            c => ["ADCO", "LFO", "HFO", "ASSO", "APTO"].includes(c.name) &&
                 Q.manhattan(c.x, c.y, x, y) <= 2).length;
          bonus += movers * 4.0;
        }
        if (n === "APTO") {
          const friendly = E.alive(st.players[owner].onBoard).length;
          bonus += Math.min(friendly * 2.5, 12.0);
        }
        return base + bonus;
      };
    }

    if (stage === "boss") {
      strat.placementBonus = (st, n, pos, owner, base) => {
        const oppCards = E.alive(st.players[E.opponentOf(owner)].onBoard);
        if (!oppCards.length) return base;
        const avgDmg = oppCards.reduce((s, c) => s + c.dmg + c.extraDamage, 0) / oppCards.length;
        const avgHp = oppCards.reduce((s, c) => s + c.hp, 0) / oppCards.length;
        let bonus = 0.0;
        if (avgDmg >= 4 && n.startsWith("TANK")) bonus += 5.0;
        if (avgHp >= 6 && n.startsWith("ASS")) bonus += 6.0;
        return base + bonus;
      };
      strat.attackBonus = (st, attacker, base) => {
        // 原版: gs.score < -2 (boss 永遠是 player2) → 一般化為「自身落後 2 分以上」
        const lead = attacker.owner === "player1" ? -st.score : st.score;
        if (lead < -2) return base + 5.0;
        return base;
      };
    }

    return strat;
  }

  const STRATEGIES = {};
  for (const s of ["white", "red", "blue", "green", "orange", "boss"]) STRATEGIES[s] = makeStrategy(s);

  /* =====================================================================
   * ai_controller.py → 同步回合 (tick 迴圈摺疊,決策邏輯不變)
   * =================================================================== */
  function bestPlacement(st, owner, strat) {
    const player = st.players[owner];
    const empties = Q.emptyPositions(st);
    if (!empties.length) return null;
    let best = null;
    for (let hi = 0; hi < player.hand.length; hi++) {
      const cardName = player.hand[hi];
      if (!Q.isPlayableUnitCard(cardName)) continue;
      for (const [x, y] of empties) {
        let score = EV.evaluatePlacement(st, cardName, [x, y], owner);
        score = strat.placementBonus(st, cardName, [x, y], owner, score);
        if (best === null || score > best.score) best = { hi, cardName, x, y, score };
      }
    }
    return best;
  }

  function bestAttack(st, owner, strat, excluded) {
    if ((st.attacks[owner] || 0) <= 0) return null;
    let best = null;
    for (const card of Q.friendlyCards(st, owner)) {
      if (excluded.has(card.uid)) continue;
      const [score0] = EV.evaluateAttack(st, card);
      if (score0 < 0) continue;
      const score = strat.attackBonus(st, card, score0);
      if (score <= 0) continue;
      if (best === null || score > best.score) best = { card, score };
    }
    return best;
  }

  function effectiveAttackMin(st, owner, strat) {
    const base = strat.attack_min_score;
    const deficit = owner === "player2" ? -st.score : st.score;
    if (deficit <= 2) return base;
    return Math.max(0.0, base - (deficit - 2) * 3.5);
  }

  /* 移動鏈 (move chain):有 moving 單位 → 走最佳目的地 */
  function driveMoveChain(st, owner) {
    const movers = Q.unitsWithPendingMove(st, owner);
    if (!movers.length) return false;
    const destScore = (u) => {
      const dests = Q.moveDestinationsFor(st, u);
      if (!dests.length) return -Infinity;
      return Math.max(...dests.map(d => EV.scoreMoveDestination(st, u, d)));
    };
    let bestUnit = movers[0], bestS = destScore(movers[0]);
    for (const m of movers.slice(1)) {
      const s = destScore(m);
      if (s > bestS) { bestS = s; bestUnit = m; }
    }
    if (bestS === -Infinity) { bestUnit.moving = false; return true; } // 無路可走,放棄
    const dests = Q.moveDestinationsFor(st, bestUnit);
    let bestDest = dests[0], bd = -Infinity;
    for (const d of dests) {
      const s = EV.scoreMoveDestination(st, bestUnit, d);
      if (s > bd) { bd = s; bestDest = d; }
    }
    E.moveCard(st, bestUnit, bestDest[0], bestDest[1]);
    E.snapshot(st, `戰役AI 移動`);
    return true;
  }

  function startUnitMove(st, owner) {
    if ((st.movings[owner] || 0) <= 0) return false;
    const onBoard = st.players[owner].onBoard;
    if (onBoard.some(c => c.moving)) return false;
    const candidates = onBoard.filter(c => !c.numbness && c.hp > 0);
    if (!candidates.length) return false;
    const destScore = (u) => {
      const dests = Q.moveDestinationsFor(st, u);
      if (!dests.length) return -Infinity;
      return Math.max(...dests.map(d => EV.scoreMoveDestination(st, u, d)));
    };
    let bestUnit = candidates[0], bestS = destScore(candidates[0]);
    for (const c of candidates.slice(1)) {
      const s = destScore(c);
      if (s > bestS) { bestS = s; bestUnit = c; }
    }
    if (bestS <= 0) return false;
    return E.spendMoving(st, owner, bestUnit);
  }

  function playMoveo(st, owner) {
    const hand = st.players[owner].hand;
    const idx = hand.indexOf("MOVEO");
    if (idx < 0) return false;
    const movable = st.players[owner].onBoard.some(
      c => !c.numbness && c.hp > 0 && Q.moveDestinationsFor(st, c).length);
    if (!movable) return false;
    return E.playCard(st, owner, idx, 0, 0);
  }

  /* ---------- boss_config.py 關卡增益 (可選) ---------- */
  function applyBuffs(st, owner, stage, mem) {
    if (!mem.initialized) {
      mem.initialized = true;
      if (stage === "green") st.luck[owner] = 65;
      if (stage === "boss") {
        while (st.players[owner].hand.length < 4) {
          const before = st.players[owner].hand.length;
          // 直接抽 (drawCard 不外露 → 用 cardToDraw + recycle)
          st.cardToDraw[owner] += 1;
          E.recycleDead(st);
          if (st.players[owner].hand.length === before) break;
        }
      }
    }
    if (stage === "boss") {
      for (const c of st.players[owner].onBoard) {
        if (!mem.buffed.has(c.uid)) {
          c.hp += 1; c.maxHp += 1;
          mem.buffed.add(c.uid);
        }
      }
    }
    const ownTurn = Math.floor(st.turnNumber / 2) + 1;
    if (stage === "orange" && ownTurn % 3 === 0 && !mem.grantedTurns.has(st.turnNumber)) {
      mem.grantedTurns.add(st.turnNumber);
      st.movings[owner] += 1;
    }
  }

  /* ---------- 主回合 ---------- */
  function takeTurn(st, owner, stage, opts) {
    opts = opts || {};
    const strat = STRATEGIES[stage] || STRATEGIES.boss;
    if (opts.buffs) {
      st._campMem = st._campMem || {};
      const mem = st._campMem[owner] = st._campMem[owner] ||
        { initialized: false, buffed: new Set(), grantedTurns: new Set() };
      applyBuffs(st, owner, stage, mem);
    }

    const failedAttackers = new Set();
    let guard = 0;
    while (guard++ < 60 && !st.winner) {
      // 移動鏈優先 (ai_controller._decide_next)
      if (driveMoveChain(st, owner)) continue;
      if (startUnitMove(st, owner)) continue;
      if (playMoveo(st, owner)) { E.snapshot(st, "戰役AI 使用MOVEO"); continue; }

      const attack = bestAttack(st, owner, strat, failedAttackers);
      const play = bestPlacement(st, owner, strat);
      const effectiveMin = effectiveAttackMin(st, owner, strat);

      const attackOk = attack !== null && attack.score >= effectiveMin;
      const playOk = play !== null && play.score >= strat.placement_min_score;

      // 1. 致命刀最優先
      if (attack !== null && attack.score >= SETTINGS.thresholds.lethal_score_threshold && attackOk) {
        if (!E.attackWith(st, owner, attack.card)) failedAttackers.add(attack.card.uid);
        else E.snapshot(st, "戰役AI 出刀");
        continue;
      }
      // 2. 放置
      if (playOk) {
        E.playCard(st, owner, play.hi, play.x, play.y);
        E.snapshot(st, `戰役AI 放置 ${play.cardName}`);
        continue;
      }
      // 3. 非致命刀
      if (attackOk) {
        if (!E.attackWith(st, owner, attack.card)) failedAttackers.add(attack.card.uid);
        else E.snapshot(st, "戰役AI 出刀");
        continue;
      }
      break; // end_turn
    }
  }

  /* 任意套牌 → 推斷關卡策略 (主色 ≥7 張用該派系,否則 boss 混編) */
  function stageForDeck(cards) {
    const counts = {};
    for (const n of cards) {
      const color = E.colorOf(n);
      counts[color] = (counts[color] || 0) + 1;
    }
    const map = { White: "white", Red: "red", Blue: "blue", Green: "green", Orange: "orange" };
    let bestColor = null, bestN = 0;
    for (const c in counts) if (counts[c] > bestN) { bestN = counts[c]; bestColor = c; }
    if (bestColor && map[bestColor] && bestN >= 7) return map[bestColor];
    return "boss";
  }

  root.ABCampaign = { SETTINGS, STAGE_AI_DECKS, STAGE_LABELS, STRATEGIES, takeTurn, stageForDeck, EV, Q };
})(typeof module !== "undefined" ? module.exports : (window.AB = window.AB || {}));
