/* =====================================================================
 * 深度搜索 (實戰助手核心)
 * 給定盤面與我方座位,束搜索展開「我方整回合的行動序列」:
 *   放置(候選格)、出刀、移動鏈、MOVEO、回血、結束回合
 * 每個終局再模擬對手的貪婪回應回合 (2-ply),以盤面評估函數比較,
 * 推薦最優序列的第一步;盤面每次更新都重新搜索。
 * ===================================================================== */
(function (root) {
  "use strict";
  const E = (typeof module !== "undefined") ? require("./engine.js").ABEngine : window.AB.ABEngine;
  const AI = (typeof module !== "undefined") ? require("./ai.js").ABAI : window.AB.ABAI;

  const W_EVAL = { lead: 3.0, mySettle: 1.6, theirSettle: 2.2, threat: 0.45 };
  const WIN = 1e6;

  function evalFor(st, owner) {
    if (st.winner) {
      if (st.winner === owner) return WIN;
      if (st.winner === "tie") return 0;
      return -WIN;
    }
    return AI.evalPosition(st, owner, W_EVAL);
  }

  /* ---------- 對手貪婪回應 (無複製,快速) ---------- */
  function staticAttackValue(st, u) {
    if (u.numbness || !u.attackTypes || u.name === "APTG") return -1;
    const enemies = E.alive(E.sideCards(st, u.owner, true));
    const cand = E.detectionCandidates(u, u.attackTypes, enemies);
    if (!cand.length) return -1;
    let dmg = u.dmg + u.extraDamage;
    if (u.name === "HFB") dmg = u.dmg + st.tokens[u.owner];
    if (u.name === "ADCDKG") dmg = u.dmg + Math.floor(st.totem[u.owner] / 4);
    if (u.name === "APTDKG") dmg = u.dmg + Math.floor(st.totem[u.owner] / 2);
    let v = 0;
    const one = (t) => {
      let s = Math.min(dmg, t.hp + t.armor);
      if (t.hp + t.armor <= dmg && t.owner !== "neutral") s += 5;
      if (t.owner === "neutral") s *= 0.1;
      if (["AP"].includes(E.jobOf(u.name)) && !t.numbness && t.owner !== "neutral") s += 3;
      return s;
    };
    for (const c of cand) {
      if (c.group) { let s = 0; for (const t of c.group) s += one(t); v += s / c.group.length; }
      else v += one(c);
    }
    return v;
  }

  const PREFS = { fragile: ["AP", "SP", "ASS", "ADC", "APT"] };

  function fastReply(st, owner) {
    const pl = st.players[owner];
    // 1) 放置: 用共享的 v3 放置評分挑格 (對手模型要夠真實,威脅投影才有意義)
    const ctx = AI.turnContext(st, owner);
    let placed = 0;
    let guard = 0;
    while (placed < 3 && guard++ < 10) {
      const units = [...new Set(pl.hand)].filter(n =>
        !["MOVEO", "MOVE", "HEAL", "CUBES"].includes(n) && E.STATS[n]);
      if (!units.length) break;
      units.sort((a, b) => (E.STATS[b].hp + E.STATS[b].dmg * 2) - (E.STATS[a].hp + E.STATS[a].dmg * 2));
      const name = units[0];
      let best = null, bestS = -Infinity;
      for (let x = 0; x < E.W; x++) for (let y = 0; y < E.H; y++) {
        if (E.cellOccupied(st, x, y)) continue;
        const s = AI.cellHeuristic(st, owner, name, x, y, PREFS, ctx);
        if (s > bestS) { bestS = s; best = [x, y]; }
      }
      if (!best) break;
      const idx = pl.hand.indexOf(name);
      if (!E.playCard(st, owner, idx, best[0], best[1])) break;
      placed++;
      if (st.winner) return;
    }
    // 2) 出刀: 靜態價值,全花
    guard = 0;
    while (st.attacks[owner] > 0 && guard++ < 12) {
      let best = null, bestV = 0.5;
      for (const u of E.alive(pl.onBoard)) {
        const v = staticAttackValue(st, u);
        if (v > bestV) { bestV = v; best = u; }
      }
      if (!best) break;
      if (!E.attackWith(st, owner, best)) break;
      if (st.winner) return;
    }
    // 3) 移動者: 走第一個可行目的地 (粗略)
    guard = 0;
    for (const m of E.alive(pl.onBoard).filter(c => c.moving)) {
      if (guard++ > 6) break;
      outer:
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        if (E.moveCard(st, m, m.x + dx, m.y + dy)) break outer;
      }
      if (st.winner) return;
    }
  }

  /* ---------- 候選行動產生 (使用共享的 v3 放置評分 + 戰術門檻) ---------- */
  function cellShortlist(st, owner, name, k, ctx) {
    const out = [];
    for (let x = 0; x < E.W; x++) for (let y = 0; y < E.H; y++) {
      if (E.cellOccupied(st, x, y)) continue;
      out.push({ x, y, s: AI.cellHeuristic(st, owner, name, x, y, PREFS, ctx) });
    }
    out.sort((a, b) => b.s - a.s);
    return out.slice(0, k);
  }

  function genCandidates(st, owner) {
    const out = [];
    const pl = st.players[owner];
    const ctx = AI.turnContext(st, owner);
    const enemies = E.alive(st.players[E.opponentOf(owner)].onBoard);

    // 放置 (每種卡 top-3 格;含戰術門檻)
    for (const name of new Set(pl.hand)) {
      if (name === "MOVEO" || name === "MOVE") {
        if (E.alive(pl.onBoard).some(c => !c.numbness)) {
          out.push({ kind: "magic_move", name, label: `使用 ${name} (+1 移動點)` });
        }
        continue;
      }
      if (name === "HEAL") {
        const hurt = E.alive(pl.onBoard).filter(c => c.maxHp - c.hp >= 4)
          .sort((a, b) => (b.maxHp - b.hp) - (a.maxHp - a.hp))[0];
        if (hurt) out.push({ kind: "heal", name, targetUid: hurt.uid, label: `回血 ${hurt.name}(${hurt.x},${hurt.y})` });
        continue;
      }
      if (name === "CUBES") continue; // 方塊不入搜索 (分支爆炸,價值低)
      if (!E.STATS[name]) continue;

      const job = E.jobOf(name);
      // 刺客門檻: 它在手上是懸頂之劍。只有「下去就有目標可砍」或局勢所迫才考慮放
      if (job === "ASS") {
        const dmg = E.STATS[name].dmg;
        const hitCells = [];
        for (let x = 0; x < E.W; x++) for (let y = 0; y < E.H; y++) {
          if (E.cellOccupied(st, x, y)) continue;
          let v = 0;
          for (const e of enemies) {
            if (Math.abs(e.x - x) === 1 && Math.abs(e.y - y) === 1) {
              v += (e.hp + e.armor <= dmg) ? 10 : 2;   // 進場即斬殺 >> 進場有目標
            }
          }
          if (v > 0) hitCells.push({ x, y, v });
        }
        hitCells.sort((a, b) => b.v - a.v);
        if (hitCells.length) {
          for (const c of hitCells.slice(0, 2)) {
            out.push({ kind: "place", name, x: c.x, y: c.y, label: `放置 ${name} → (${c.x},${c.y})` });
          }
        } else if (ctx.behind || ctx.enemyLethal || ctx.round >= 5) {
          // 局勢需要身位時才允許「無目標放置」,且只取最佳一格
          const cell = cellShortlist(st, owner, name, 1, ctx)[0];
          if (cell) out.push({ kind: "place", name, x: cell.x, y: cell.y, label: `放置 ${name} → (${cell.x},${cell.y})` });
        }
        continue;
      }

      for (const cell of cellShortlist(st, owner, name, 3, ctx)) {
        out.push({ kind: "place", name, x: cell.x, y: cell.y, label: `放置 ${name} → (${cell.x},${cell.y})` });
      }
    }
    // 出刀
    if (st.attacks[owner] > 0) {
      for (const u of E.alive(pl.onBoard)) {
        if (u.numbness || !u.attackTypes || u.name === "APTG") continue;
        const enemies = E.alive(E.sideCards(st, owner, true));
        if (!E.detectionCandidates(u, u.attackTypes, enemies).length) continue;
        out.push({ kind: "attack", uid: u.uid, label: `出刀 ${u.name}(${u.x},${u.y})` });
      }
    }
    // 移動 (待移動者 top-3 目的地;或用移動點武裝)
    const movers = E.alive(pl.onBoard).filter(c => c.moving);
    for (const m of movers.slice(0, 2)) {
      let added = 0;
      for (let dx = -1; dx <= 1 && added < 3; dx++) for (let dy = -1; dy <= 1 && added < 3; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = m.x + dx, ny = m.y + dy;
        if (E.validPos(nx, ny) && !E.cellOccupied(st, nx, ny)) {
          out.push({ kind: "move", uid: m.uid, x: nx, y: ny, label: `移動 ${m.name} → (${nx},${ny})` });
          added++;
        }
      }
    }
    if (!movers.length && st.movings[owner] > 0) {
      for (const u of E.alive(pl.onBoard).slice(0, 6)) {
        if (u.numbness || u.moving) continue;
        out.push({ kind: "arm", uid: u.uid, label: `啟動移動 ${u.name}(${u.x},${u.y})` });
      }
    }
    // 結束回合永遠是選項
    out.push({ kind: "end", label: "結束回合" });
    return out;
  }

  function applyAction(st, owner, a) {
    const pl = st.players[owner];
    const logStart = st.log.length;
    let ok = false;
    switch (a.kind) {
      case "place": {
        const idx = pl.hand.indexOf(a.name);
        ok = idx >= 0 && E.playCard(st, owner, idx, a.x, a.y);
        break;
      }
      case "attack": {
        const u = E.alive(pl.onBoard).find(c => c.uid === a.uid);
        ok = !!u && E.attackWith(st, owner, u);
        break;
      }
      case "move": {
        const u = E.alive(pl.onBoard).find(c => c.uid === a.uid);
        ok = !!u && u.moving && E.moveCard(st, u, a.x, a.y);
        break;
      }
      case "arm": {
        const u = E.alive(pl.onBoard).find(c => c.uid === a.uid);
        ok = !!u && E.spendMoving(st, owner, u);
        break;
      }
      case "magic_move": {
        const idx = pl.hand.indexOf(a.name);
        ok = idx >= 0 && E.playCard(st, owner, idx, 0, 0);
        break;
      }
      case "heal": {
        const idx = pl.hand.indexOf("HEAL");
        if (idx >= 0) E.playCard(st, owner, idx, 0, 0);
        const t = E.alive(pl.onBoard).find(c => c.uid === a.targetUid);
        ok = !!t && E.healAt(st, owner, t.x, t.y);
        break;
      }
      case "end": {
        E.endTurn(st);
        ok = true;
        break;
      }
    }
    const events = st.log.slice(logStart);
    return { ok, events };
  }

  /* ---------- 狀態指紋 (去重: 不同順序到達同一局面只保留一條路徑) ---------- */
  function stateKey(st, owner) {
    const cells = E.allCards(st).filter(c => c.hp > 0)
      .map(c => `${c.owner[6] || "n"}${c.name}${c.x}${c.y}:${c.hp},${c.armor},${c.numbness ? 1 : 0},${c.moving ? 1 : 0}`)
      .sort().join("|");
    const me = st.players[owner];
    return cells + "#" + me.hand.slice().sort().join(",") +
      `#${st.attacks[owner]},${st.movings[owner]},${st.tokens[owner]},${st.totem[owner]},${st.heals[owner]},${st.turnNumber}`;
  }

  /* ---------- 主搜索 ---------- */
  function deepSearch(st0, owner, opts) {
    opts = opts || {};
    const BEAM = opts.beam || 8;
    const MAX_DEPTH = opts.maxDepth || 8;
    const t0 = Date.now();

    let beam = [{ st: E.cloneState(st0), plan: [], done: false, score: evalFor(st0, owner) }];
    let nodesExpanded = 0;
    const seen = new Map();   // stateKey → 已知最高分

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const next = [];
      let anyOpen = false;
      for (const node of beam) {
        if (node.done) { next.push(node); continue; }
        anyOpen = true;
        const cands = genCandidates(node.st, owner);
        for (const a of cands) {
          const cl = E.cloneState(node.st);
          const { ok, events } = applyAction(cl, owner, a);
          if (!ok) continue;
          nodesExpanded++;
          const done = a.kind === "end" || !!cl.winner;
          const score = evalFor(cl, owner);
          if (!done) {   // 終局節點不去重 (要保留進入對手回應評估)
            const key = stateKey(cl, owner);
            const prev = seen.get(key);
            if (prev !== undefined && prev >= score) continue;   // 換個順序到同一局面 → 跳過
            seen.set(key, score);
          }
          next.push({
            st: cl,
            plan: [...node.plan, { ...a, events: events.slice(0, 3) }],
            done,
            score,
          });
        }
      }
      if (!anyOpen) break;
      next.sort((x, y) => y.score - x.score);
      beam = next.slice(0, BEAM + 2);
    }

    // 未收尾的節點補上結束回合
    for (const node of beam) {
      if (!node.done) {
        const { events } = applyAction(node.st, owner, { kind: "end", label: "結束回合" });
        node.plan.push({ kind: "end", label: "結束回合", events: events.slice(0, 2) });
        node.done = true;
      }
    }

    // 終局評估: 模擬對手回應一整個回合後再評
    const opp = E.opponentOf(owner);
    for (const node of beam) {
      if (node.st.winner) {
        node.finalScore = node.st.winner === owner
          ? WIN - node.plan.length                                        // 越快贏越好
          : evalFor(node.st, owner) + AI.evalPosition(node.st, owner, W_EVAL) * 1e-3;
        continue;
      }
      const replySt = E.cloneState(node.st);
      if (E.currentPlayer(replySt) === opp) {
        fastReply(replySt, opp);
        if (!replySt.winner) E.endTurn(replySt);
      }
      if (replySt.winner && replySt.winner !== owner && replySt.winner !== "tie") {
        // 敗局難免: 以「最大抵抗」排序 (否定越多越好,而非全部同分)
        node.finalScore = -WIN + AI.evalPosition(replySt, owner, W_EVAL) * 1e-3 - node.plan.length * 1e-5;
      } else {
        node.finalScore = evalFor(replySt, owner) - node.plan.length * 0.01;
      }
    }

    beam.sort((a, b) => b.finalScore - a.finalScore);
    const best = beam[0];

    // 替代方案: 第一步不同的次優序列
    const alternatives = [];
    const firstLabel = best.plan.length ? best.plan[0].label : "";
    for (const node of beam.slice(1)) {
      const f = node.plan.length ? node.plan[0].label : "結束回合";
      if (f !== firstLabel && !alternatives.some(alt => alt.first === f)) {
        alternatives.push({ first: f, score: node.finalScore });
        if (alternatives.length >= 3) break;
      }
    }

    return {
      bestPlan: best.plan,
      firstAction: best.plan[0] || { kind: "end", label: "結束回合" },
      finalScore: best.finalScore,
      winFound: best.st.winner === owner,
      loseUnavoidable: beam.every(n => n.finalScore <= -WIN / 2),
      alternatives,
      nodesExpanded,
      elapsedMs: Date.now() - t0,
    };
  }

  root.ABSearch = { deepSearch, fastReply };
})(typeof module !== "undefined" ? module.exports : (window.AB = window.AB || {}));
