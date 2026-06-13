/* 診斷: 鏡像重播失敗的動作與原因 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ABEngine: E } = require("./engine.js");

const dir = "./test_records";
const file = fs.readdirSync(dir)
  .filter(f => f.endsWith(".jsonl"))
  .map(f => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0].f;
console.log("檔案:", file);

const records = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);

const deck1 = records.find(r => (r.message || "").startsWith("player1 deck ")).message.slice(13).split("-");
const deck2 = records.find(r => (r.message || "").startsWith("player2 deck ")).message.slice(13).split("-");
const draws = { player1: [], player2: [] };
for (const r of records) if ((r.message || "").includes(" drew ")) draws[r.player_name].push(r.card_name);

const st = E.createState(deck1, deck2, 1, {
  drawScript: { player1: draws.player1.slice(), player2: draws.player2.slice() }, maxTurns: 200,
});
st.deckOf = { player1: "custom", player2: "custom" };
st.deckLists = { player1: deck1, player2: deck2 };

let n = 0, failures = 0;
for (const r of records) {
  if (r.is_action !== true) continue;
  n++;
  const owner = r.action_player, x = r.board_x, y = r.board_y;
  let ok = true, why = "";
  if (r.action_type === "play_card") {
    const name = st.players[owner].hand[r.hand_index];
    ok = E.playCard(st, owner, r.hand_index, x ?? 0, y ?? 0);
    if (!ok) why = `放置失敗 ${name}@(${x},${y}) 格占用=${E.cellOccupied(st, x, y)}`;
  } else if (r.action_type === "attack") {
    const u = E.alive(st.players[owner].onBoard).find(c => c.x === x && c.y === y);
    if (!u) { ok = false; why = `攻擊: (${x},${y}) 無我方單位`; }
    else {
      ok = E.attackWith(st, owner, u);
      if (!ok) {
        const enemies = E.alive(E.sideCards(st, owner, true));
        const inRange = E.detectionCandidates(u, u.attackTypes, enemies).length;
        why = `攻擊失敗 ${u.name}@(${x},${y}) numb=${u.numbness} 刀=${st.attacks[owner]} 範圍內目標=${inRange}`;
      }
    }
  } else if (r.action_type === "end_turn") {
    E.endTurn(st);
  }
  if (!ok) { failures++; console.log(`#${n} [${owner}] ${r.action_type} → ${why}`); }
}
console.log(`共 ${n} 動作, ${failures} 失敗 | 鏡像 score: ${st.score} (真實 8) turn: ${st.turnNumber}`);
