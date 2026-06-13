/* Node 冒煙測試: node smoke.js [games] */
const { ABAI } = require("./ai.js");

const N = parseInt(process.argv[2] || "60", 10);
const pairs = [
  ["blueControl", "redWhiteAggro"],
  ["blueControl", "darkGreenTotem"],
  ["redWhiteAggro", "darkGreenTotem"],
];

console.log(`每組 ${N} 場 (輪流先後手)\n`);
for (const [a, b] of pairs) {
  const t0 = Date.now();
  const r = ABAI.runBatch(a, b, N, 12345);
  const ms = Date.now() - t0;
  const wa = (100 * r.winsA / N).toFixed(1);
  const wb = (100 * r.winsB / N).toFixed(1);
  const avgT = (r.totalTurns / N / 2).toFixed(1);
  console.log(`${ABAI.DECKS[a].label}  vs  ${ABAI.DECKS[b].label}`);
  console.log(`  A勝 ${r.winsA} (${wa}%) | B勝 ${r.winsB} (${wb}%) | 平 ${r.ties} | 平均 ${avgT} 輪 | ${ms}ms`);
  console.log(`  A先手勝率 ${(100 * r.winsAFirst / r.gamesAFirst).toFixed(1)}% | A後手勝率 ${(100 * r.winsASecond / r.gamesASecond).toFixed(1)}%\n`);
}

// 單場詳細回放健全性
const g = ABAI.runGame("blueControl", "redWhiteAggro", 42, { record: true });
console.log(`單場回放: ${g.record.length} 個快照, 勝者 ${g.winnerDeck}, ${g.turns} 個半回合, 終分 ${g.finalScore}`);
const last = g.record[g.record.length - 1];
console.log(`末快照棋盤單位數: ${last.board.length}`);
