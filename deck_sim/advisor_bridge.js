/* =====================================================================
 * 實戰助手・偵測橋接器 (Node)
 *
 * 即時讀取真實遊戲 (FOS brainstorming) 寫入的 battle_records/*.jsonl
 * (遊戲每個動作都逐行 flush),重建精確盤面鏡像:
 *   - 抽牌記錄含牌名 → 雙方手牌/牌庫 100% 精確 (drawScript)
 *   - is_action 記錄 → 在本引擎重播所有動作 (規則效果完整推進)
 *   - 戰鬥/回收/移動記錄 → 事件帳本,校正引擎鏡像的隨機性偏差
 * 每次更新寫出 advisor_state.json,網站「實戰助手」分頁讀取並深度搜索。
 *
 * 用法:
 *   node advisor_bridge.js                          # 監看預設 battle_records
 *   node advisor_bridge.js --dir <資料夾> [--once] [--file <jsonl>]
 * ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const { ABEngine: E } = require("./engine.js");
const { ABSearch: S } = require("./search.js");

const DEFAULT_DIRS = [
  "C:\\Users\\Evan\\AfternoonBrainstorming\\FOS brainstorming\\battle_records",
  "C:\\Users\\Evan\\Downloads\\AfternoonBrainstorming\\FOS brainstorming\\battle_records",
];

/* ---------- CLI ---------- */
const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const ONCE = args.includes("--once");
const FIXED_FILE = argVal("--file");
const OUT_PATH = argVal("--out") || path.join(__dirname, "advisor_state.json");
const POLL_MS = parseInt(argVal("--interval") || "500", 10);
const SEAT = argVal("--seat") || "player1";          // player1 | player2 | auto (熱座雙方都提示)
const STRENGTH = argVal("--strength") || "std";      // fast | std | deep
const SEARCH_TIERS = { fast: { beam: 5, maxDepth: 7 }, std: { beam: 9, maxDepth: 9 }, deep: { beam: 14, maxDepth: 10 } };
let RECORDS_DIR = argVal("--dir");
if (!RECORDS_DIR) {
  RECORDS_DIR = DEFAULT_DIRS.find(d => fs.existsSync(d)) || DEFAULT_DIRS[0];
}

/* ---------- 工具 ---------- */
function newestJsonl(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? files[0].f : null;
}

function parseRecords(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* 半行未寫完,略過 */ }
  }
  return out;
}

function parseUid(uid) {
  // "player1_TANKW" → {owner, name}
  const i = uid.indexOf("_");
  if (i < 0) return { owner: "?", name: uid };
  return { owner: uid.slice(0, i), name: uid.slice(i + 1) };
}

/* =====================================================================
 * 鏡像重建 (每批新記錄全量重建 — 無狀態,杜絕增量漂移)
 * =================================================================== */
function buildMirror(records) {
  const notes = [];

  // --- 1) 表頭: 牌組 + 戰役關卡 ---
  let deck1 = null, deck2 = null, version = null, campaignStage = null;
  for (const r of records) {
    const msg = r.message || "";
    if (msg.startsWith("player1 deck ")) deck1 = msg.slice("player1 deck ".length).split("-").filter(Boolean);
    if (msg.startsWith("player2 deck ")) deck2 = msg.slice("player2 deck ".length).split("-").filter(Boolean);
    if (msg.startsWith("campaign stage ")) campaignStage = msg.slice("campaign stage ".length).trim();
    if (r.version) version = r.version;
    if (r.is_action) break;
  }
  if (!deck1 || !deck2) {
    return { error: "日誌缺少牌組表頭 (player1/player2 deck ...),尚未開局或格式不符" };
  }
  const unknown = deck1.concat(deck2).filter(n => !E.STATS[n]);
  if (unknown.length) notes.push(`未知卡牌 (引擎未實作): ${[...new Set(unknown)].join(",")}`);

  // --- 2) 抽牌腳本 (精確手牌) ---
  const drawScript = { player1: [], player2: [] };
  for (const r of records) {
    if ((r.message || "").includes(" drew ") && r.card_name && r.player_name) {
      if (drawScript[r.player_name]) drawScript[r.player_name].push(r.card_name);
    }
  }

  // --- 3) 引擎鏡像: 重播動作 ---
  const st = E.createState(deck1, deck2, 1, {
    record: false, maxTurns: 200,
    drawScript: { player1: drawScript.player1.slice(), player2: drawScript.player2.slice() },
  });
  st.deckOf = { player1: "custom", player2: "custom" };
  st.deckLists = { player1: deck1.slice(), player2: deck2.slice() };

  // --- 戰役關卡增益複製 (boss_config.py): AI = player2 ---
  const bossBuffed = new Set();
  if (campaignStage === "green") st.luck.player2 = 65;
  function applyCampaignBuffs() {
    if (!campaignStage) return;
    if (campaignStage === "boss") {
      for (const c of st.players.player2.onBoard) {
        if (!bossBuffed.has(c.uid)) {
          c.hp += 1; c.maxHp += 1;
          bossBuffed.add(c.uid);
        }
      }
    }
  }
  function applyCampaignTurnBuffs() {
    // 在 player2 (戰役AI) 回合開始時觸發 (turn_number 為奇數)
    if (!campaignStage || st.turnNumber % 2 === 0) return;
    const aiTurn = (st.turnNumber + 1) / 2;
    if (campaignStage === "orange" && aiTurn % 3 === 0) st.movings.player2 += 1;
    if (campaignStage === "boss" && aiTurn % 5 === 0) st.heals.player2 += 1;
  }

  // 動作分段: 每個 action 之後到下一個 action 之前的事件記錄 (用於強制真實攻擊目標)
  const actionEventBlocks = [];
  {
    let cur = null;
    for (const r of records) {
      if (r.is_action === true) { cur = []; actionEventBlocks.push(cur); }
      else if (cur) cur.push(r);
    }
  }

  /* ---- 增量帳本: 真實棋盤的逐動作真相 ---- */
  const liveLedger = [];   // {owner, name, x, y, hp, maxHp, bornTurn}
  let realTurn = 0;
  function ledgerFeed(ev) {
    const msg = ev.message || "";
    if (msg.includes(" played ") && ev.card && ev.position && E.STATS[ev.card] && E.STATS[ev.card].hp > 0) {
      const owner = ev.card === "CUBE" ? "neutral" : ev.player;
      // Boss 關卡: AI (player2) 單位 +1 血 (boss_config.py unit_hp_plus)
      const hpBonus = (campaignStage === "boss" && owner === "player2") ? 1 : 0;
      liveLedger.push({ owner, name: ev.card, x: ev.position[0], y: ev.position[1],
                        hp: E.STATS[ev.card].hp + hpBonus, maxHp: E.STATS[ev.card].hp + hpBonus, bornTurn: realTurn });
    } else if (msg.includes("lucky block spawned") && ev.position) {
      liveLedger.push({ owner: "neutral", name: "LUCKYBLOCK", x: ev.position[0], y: ev.position[1],
                        hp: 1, maxHp: 1, bornTurn: realTurn });
    } else if (msg.includes(" moved ") && ev.card_name && ev.start_position && ev.target_position) {
      const u = liveLedger.find(c => c.owner === ev.player_name && c.name === ev.card_name &&
                                     c.x === ev.start_position[0] && c.y === ev.start_position[1] && c.hp > 0);
      if (u) { u.x = ev.target_position[0]; u.y = ev.target_position[1]; }
    } else if (msg.includes(" attacked ") && ev.target && ev.target_position && typeof ev.damage === "number") {
      const t = parseUid(ev.target);
      const u = liveLedger.find(c => c.owner === t.owner && c.name === t.name &&
                                     c.x === ev.target_position[0] && c.y === ev.target_position[1] && c.hp > 0);
      if (u) u.hp = Math.max(0, u.hp - ev.damage);
    } else if (msg.includes(" recycled ") && ev.card_name && ev.position) {
      const u = liveLedger.find(c => c.owner === ev.player_name && c.name === ev.card_name &&
                                     c.x === ev.position[0] && c.y === ev.position[1] && c.hp >= 0) ||
                liveLedger.find(c => c.owner === ev.player_name && c.name === ev.card_name && c.hp >= 0);
      if (u) u.hp = -1;   // -1 = 確認死亡 (回收)
    } else if (msg.includes(" played HEAL at ") && ev.position) {
      const u = liveLedger.find(c => c.x === ev.position[0] && c.y === ev.position[1] && c.owner !== "neutral" && c.hp > 0);
      if (u) u.hp = Math.min(u.maxHp, u.hp + 6);
    } else if (msg.startsWith("Turn ") && ev.turn !== undefined) {
      realTurn = ev.turn;
    }
  }

  /* 每個動作後: 將鏡像棋盤快照到帳本真相
   *  - 生死: 只認 recycled 記錄 (hp === -1)。真實死亡必寫回收記錄;
   *          沒有回收記錄 = 必定存活 (帳本血量歸零可能只是護甲吸收被重複計算)。
   *  - 位置: 帳本權威 (played/moved 記錄)。
   *  - 血量: 取 max(引擎鏡像, 帳本估計)。日誌傷害值含護甲吸收量,帳本是下界;
   *          引擎鏡像自己會推進護甲,通常更準。
   */
  let corrections = 0;
  function snapBoardToLedger() {
    const truthAlive = liveLedger.filter(u => u.hp !== -1);   // 未被回收 = 存活
    for (const side of ["player1", "player2"]) {
      const truth = truthAlive.filter(u => u.owner === side);
      const mirrorUnits = E.alive(st.players[side].onBoard);
      const used = new Set();
      for (const tu of truth) {
        let m = mirrorUnits.find(c => !used.has(c.uid) && c.name === tu.name && c.x === tu.x && c.y === tu.y);
        if (!m) m = mirrorUnits.find(c => !used.has(c.uid) && c.name === tu.name);
        if (m) {
          used.add(m.uid);
          if (m.x !== tu.x || m.y !== tu.y) { m.x = tu.x; m.y = tu.y; corrections++; }
          const est = Math.min(Math.max(m.hp, tu.hp, 1), m.maxHp);
          if (m.hp !== est) { m.hp = est; corrections++; }
        } else {
          // 鏡像誤殺 → 復活 (真實中沒有回收記錄 = 存活)
          const fresh = E.makeCard(tu.name, side, tu.x, tu.y);
          fresh.hp = Math.max(tu.hp, 1);
          if (campaignStage === "boss" && side === "player2") { fresh.hp += 1; fresh.maxHp += 1; bossBuffed.add(fresh.uid); }
          fresh.numbness = (tu.bornTurn === realTurn);  // 本回合放置的才麻痺
          st.players[side].onBoard.push(fresh);
          corrections++;
        }
      }
      for (const m of mirrorUnits) {
        if (!used.has(m.uid)) { m.hp = 0; corrections++; }   // 帳本確認死亡或不存在 → 移除
      }
    }
    // 中立 CUBE 依帳本;LUCKYBLOCK 生成多半無記錄,僅同步血量歸零者
    const cubeTruth = truthAlive.filter(u => u.owner === "neutral" && u.name === "CUBE");
    st.neutral = st.neutral.filter(c => c.name !== "CUBE");
    for (const cu of cubeTruth) {
      const fresh = E.makeCard("CUBE", "neutral", cu.x, cu.y);
      fresh.hp = cu.hp;
      st.neutral.push(fresh);
    }
    E.recycleDead(st);
  }

  function reconcileBlock(block) {
    for (const ev of block) {
      ledgerFeed(ev);
      const msg = ev.message || "";
      if (msg.includes(" attacked ") && ev.attacker && ev.target && ev.target_position) {
        const a = parseUid(ev.attacker);
        if (E.jobOf(a.name) === "AP") {
          const t = parseUid(ev.target);
          const cand = t.owner === "neutral" ? st.neutral :
            (st.players[t.owner] ? st.players[t.owner].onBoard : []);
          const tu = E.alive(cand).find(c => c.name === t.name &&
            c.x === ev.target_position[0] && c.y === ev.target_position[1]);
          if (tu) tu.numbness = true;   // 真實麻痺對象
        }
      }
    }
    snapBoardToLedger();
  }

  let applied = 0, failed = 0, actionIdx = -1;
  for (const r of records) {
    if (r.is_action !== true) continue;
    actionIdx++;
    if (st.winner) break;
    const owner = r.action_player;
    const type = r.action_type;
    const x = r.board_x, y = r.board_y;
    try {
      switch (type) {
        case "play_card": {
          if (r.hand_index === null || r.hand_index === undefined) { failed++; break; }
          if (!E.playCard(st, owner, r.hand_index, x ?? 0, y ?? 0)) failed++;
          else applied++;
          break;
        }
        case "attack": {
          const u = E.alive(st.players[owner].onBoard).find(c => c.x === x && c.y === y);
          if (!u) { failed++; break; }
          // 從事件區塊取真實攻擊目標 (固定 nearest/farthest 的隨機選擇與麻痺對象)
          const block = actionEventBlocks[actionIdx] || [];
          const forced = [];
          for (const ev of block) {
            if ((ev.message || "").includes(" attacked ") && ev.attacker && ev.attacker_position &&
                ev.attacker === `${owner}_${u.name}` &&
                ev.attacker_position[0] === x && ev.attacker_position[1] === y) {
              const t = parseUid(ev.target);
              const candidates = t.owner === "neutral" ? st.neutral :
                (st.players[t.owner] ? st.players[t.owner].onBoard : []);
              const tu = E.alive(candidates).find(c => c.name === t.name &&
                c.x === ev.target_position[0] && c.y === ev.target_position[1]);
              if (tu && !forced.includes(tu)) forced.push(tu);
            }
          }
          if (E.attackWith(st, owner, u, forced.length ? forced : undefined)) applied++;
          else failed++;
          break;
        }
        case "move_to": {
          // 模擬 player.move_card 的兩段式語意
          const pl = st.players[owner];
          const movers = E.alive(pl.onBoard).filter(c => c.moving);
          if (!movers.length) {
            const u = E.alive(pl.onBoard).find(c => c.x === x && c.y === y);
            if (u && E.spendMoving(st, owner, u)) applied++;
          } else {
            const sel = movers.find(m => m._sel);
            if (sel) {
              sel._sel = false;
              if (E.moveCard(st, sel, x, y)) applied++; else failed++;
            } else {
              const u = movers.find(c => c.x === x && c.y === y) ||
                        E.alive(pl.onBoard).find(c => c.x === x && c.y === y && c.moving);
              if (u) { u._sel = true; applied++; }
              else if (movers.length === 1) {
                // 寬容: 只有一個移動者時直接視為目的地點擊
                if (E.moveCard(st, movers[0], x, y)) applied++; else failed++;
              } else failed++;
            }
          }
          break;
        }
        case "heal": {
          if (E.healAt(st, owner, x, y)) applied++; else failed++;
          break;
        }
        case "spawn_cube": {
          if (E.spawnCube(st, owner, x, y)) applied++; else failed++;
          break;
        }
        case "end_turn": {
          E.endTurn(st);
          applyCampaignTurnBuffs();
          applied++;
          break;
        }
        default: break; // toggle_hint / quit 等忽略
      }
    } catch (e) {
      failed++;
      notes.push(`動作重播例外 ${type}: ${e.message}`);
    }
    applyCampaignBuffs();
    reconcileBlock(actionEventBlocks[actionIdx] || []);
  }
  if (failed) notes.push(`${failed} 個動作未能精確重播 (多為真實對局中的無效操作,行為一致)`);

  // --- 4) 開局前事件 (表頭區) 餵入帳本 ---
  //     (動作迴圈已逐塊餵入;此處補上第一個動作之前的記錄,通常無棋盤事件)

  // --- 5) 後設資訊 ---
  const actions = records.filter(r => r.is_action === true);
  const lastEvents = records.slice(-14).map(r => r.message || "").filter(Boolean);

  return {
    state: st,
    meta: {
      version, deck1, deck2, campaignStage,
      actionCount: actions.length,
      applied, failed, corrections,
      currentPlayer: E.currentPlayer(st),
      turnNumber: st.turnNumber,
      score: st.score,
      winner: st.winner,
      notes, lastEvents,
    },
  };
}

/* =====================================================================
 * 內建深度搜索 → 浮動提示窗用的建議 (不依賴瀏覽器)
 * =================================================================== */
function computeHint(st) {
  try {
    if (st.winner) {
      return { mode: "over", text: `對局結束 (${st.winner === "tie" ? "平手" : E.zh(st.winner)} 獲勝)` };
    }
    const cur = E.currentPlayer(st);
    if (SEAT !== "auto" && cur !== SEAT) {
      return { mode: "waiting", forSeat: SEAT, currentPlayer: cur, text: "等待對手行動…" };
    }
    const tier = SEARCH_TIERS[STRENGTH] || SEARCH_TIERS.std;
    const r = S.deepSearch(st, cur, tier);
    // 高亮格: 放置/移動的目標格、出刀單位所在格
    const cells = [];
    const a = r.firstAction;
    if (a.x !== undefined && a.y !== undefined) cells.push([a.x, a.y]);
    if (a.kind === "attack" && a.uid) {
      const u = E.alive(st.players[cur].onBoard).find(c => c.uid === a.uid);
      if (u) cells.push([u.x, u.y]);
    }
    return {
      mode: "rec",
      forSeat: cur,
      first: a.label,
      plan: r.bestPlan.map(p => p.label),
      planEvents: r.bestPlan.map(p => (p.events || []).slice(0, 1).join("")),
      cells,
      winFound: r.winFound,
      loseUnavoidable: r.loseUnavoidable,
      evalScore: r.finalScore > 1e5 ? "必勝" : (r.finalScore < -1e5 ? "劣勢" : r.finalScore.toFixed(1)),
      elapsedMs: r.elapsedMs,
    };
  } catch (e) {
    return { mode: "error", text: "搜索失敗: " + e.message };
  }
}

/* =====================================================================
 * 輸出與監看
 * =================================================================== */
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 短暫同步等待 */ }
}

function writeOut(payload) {
  const text = JSON.stringify(payload);
  const tmp = OUT_PATH + ".tmp";
  // Windows: 瀏覽器輪詢時 http server 可能短暫鎖住目標檔 → rename EPERM。
  // 重試幾次,仍失敗就直接覆寫 (非原子;讀取端解析失敗會在下次輪詢自癒)。
  for (let i = 0; i < 5; i++) {
    try {
      fs.writeFileSync(tmp, text, "utf-8");
      fs.renameSync(tmp, OUT_PATH);
      return true;
    } catch (e) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      sleepSync(25 * (i + 1));
    }
  }
  try {
    fs.writeFileSync(OUT_PATH, text, "utf-8");
    return true;
  } catch (e) {
    console.log(`[bridge] 寫出暫時失敗 (${e.code}),下次更新重試`);
    return false;
  }
}

let lastFile = null;
let lastSize = -1;
let lastActionCount = -1;

function tick() {
  const file = FIXED_FILE || newestJsonl(RECORDS_DIR);
  if (!file || !fs.existsSync(file)) {
    if (lastFile !== "none") {
      console.log(`[bridge] 等待對局開始… (監看 ${RECORDS_DIR})`);
      writeOut({ updatedAt: Date.now(), status: "waiting", dir: RECORDS_DIR });
      lastFile = "none";
    }
    return;
  }
  const size = fs.statSync(file).size;
  if (file === lastFile && size === lastSize) return;
  lastFile = file; lastSize = size;

  const text = fs.readFileSync(file, "utf-8");
  const records = parseRecords(text);
  const result = buildMirror(records);
  if (result.error) {
    writeOut({ updatedAt: Date.now(), status: "error", error: result.error, sourceFile: path.basename(file) });
    console.log(`[bridge] ${result.error}`);
    return;
  }
  const dump = E.dumpState(result.state);
  const hint = computeHint(result.state);
  const ok = writeOut({
    updatedAt: Date.now(),
    status: "ok",
    sourceFile: path.basename(file),
    stateDump: dump,
    meta: result.meta,
    hint,
  });
  if (!ok) { lastSize = -1; return; }   // 寫出失敗 → 下一輪重建重寫
  if (result.meta.actionCount !== lastActionCount) {
    lastActionCount = result.meta.actionCount;
    console.log(`[bridge] ${path.basename(file)} | 動作 ${result.meta.actionCount} | 第 ${Math.floor(result.meta.turnNumber / 2) + 1} 輪 ${result.meta.currentPlayer} | 分數 ${result.meta.score} | 校正 ${result.meta.corrections}`);
  }
}

/* 任何暫時性錯誤 (檔案半寫入/掃毒鎖檔...) 都不可殺掉監看迴圈 */
function safeTick() {
  try {
    tick();
  } catch (e) {
    console.log(`[bridge] 本輪略過 (${e.code || e.message}),續跑…`);
    lastSize = -1;   // 強制下一輪重讀
  }
}

console.log(`[bridge] 實戰助手橋接器啟動`);
console.log(`[bridge] 監看資料夾: ${FIXED_FILE || RECORDS_DIR}`);
console.log(`[bridge] 輸出: ${OUT_PATH}`);
safeTick();
if (!ONCE) setInterval(safeTick, POLL_MS);
else console.log("[bridge] --once 模式,處理完畢");
