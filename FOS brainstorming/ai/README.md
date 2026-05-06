# AI for Afternoon Brainstorming

MCTS-based decision engine for the card game, with a full AlphaZero-style
distillation pipeline: self-play → supervised training → evaluation → iterate.

> **中文完整訓練流程在文件最後** —— 直接跳到 [本地端訓練流程（中文）](#本地端訓練流程中文)

## Architecture overview

```
GameState  ──clone──►  MCTS (UCT / PUCT)  ──►  best action
                          │
                    search_with_visits
                          │
                    (state, π, z) samples
                          │
                    SelfPlayDataset
                          │
                    PolicyValueNet (MLP)
                          │
                   policy head + value head
                          │
                    AlphaZero loop ──► best.pt
```

## Module reference

| File | Purpose |
|---|---|
| `state_utils.py` | Clone state (noop-logger swap), terminal check, reward |
| `action_space.py` | Legal actions: attack / play_card / heal / spawn_cube / end_turn / **move** |
| `heuristic.py` | Leaf eval combining score, HP, unit count, hand tempo |
| `mcts.py` | UCT/PUCT search with Dirichlet noise + temperature sampling |
| `encode.py` | GameState → 124-dim feature vector |
| `policy_net.py` | MLP + residual skip; ACTION_DIM = 369 (includes move) |
| `random_bot.py` | Baseline: random legal action (slightly biased toward non-pass) |
| `bot.py` | `MCTSBot` / `PolicyBot` (falls back to MCTS if torch missing) |
| `play_match.py` | Run one bot-vs-bot game; CLI demo |
| `self_play.py` | Generate (features, π, z) JSONL; multiprocess + temperature annealing |
| `train.py` | Supervised distillation: cosine LR, grad clip, val split, accuracy metric |
| `alphazero.py` | Full iterative loop: self-play → train → eval → promote |

## Action space (v2, ACTION_DIM = 369)

| Slot | Action |
|---|---|
| 0 | end_turn |
| 1–16 | attack(cell) |
| 17–80 | play_card(hand_slot, cell) — 4 slots × 16 cells |
| 81–96 | heal(cell) |
| 97–112 | spawn_cube(cell) |
| 113–368 | move(from_cell, to_cell) — 16 × 16 grid |

Move actions are enumerated only when `number_of_movings > 0` (from MOVE/MOVEO
cards) and the moving card is not numb (freshly placed cards start numb —
they become eligible to move on the next turn).

## Quick start

All commands run from `FOS brainstorming/` (the directory containing `main.py`).

### Smoke test — MCTS vs random

```bash
python -m ai.play_match --p1 mcts --p2 random --sims 200 --verbose
```

### Generate self-play data (single-process)

```bash
python -m ai.self_play --games 50 --sims 200 --out data/selfplay.jsonl
```

### Generate with multiprocessing

```bash
python -m ai.self_play --games 100 --sims 200 --workers 4 --out data/selfplay.jsonl
```

### Generate with trained model priors (PUCT mode)

```bash
python -m ai.self_play --games 50 --sims 200 \
    --checkpoint checkpoints/best.pt --out data/selfplay.jsonl
```

### Train the distilled network

```bash
pip install torch
python -m ai.train \
    --data data/selfplay.jsonl \
    --epochs 50 \
    --out checkpoints/policy.pt
```

### Resume training on new data (iterative)

```bash
python -m ai.train \
    --data data/new_games.jsonl \
    --resume checkpoints/policy.pt \
    --epochs 15 \
    --out checkpoints/policy_v2.pt
```

### Full AlphaZero loop

```bash
python -m ai.alphazero \
    --iterations 20 \
    --games-per-iter 30 \
    --sims 300 \
    --epochs 20 \
    --eval-games 30 \
    --out-dir runs/az_v1
```

### Use the trained bot in code

```python
from ai.bot import PolicyBot, MCTSBot

# Trained net (falls back to MCTS if checkpoint missing / torch absent):
bot = PolicyBot("runs/az_v1/best.pt")

# Pure MCTS (no torch required):
bot = MCTSBot(simulations=400)

action = bot.pick(game_state)          # returns a GameAction
```

## MCTS features (v2)

| Feature | Default |
|---|---|
| Dirichlet noise at root | α=0.3, ε=0.25 (use `add_noise=True` in self-play) |
| PUCT exploration | enabled when `policy_fn` is supplied |
| Temperature sampling | τ=1.0 for first `--temp-cutoff` turns, then τ→0 |
| Rollout policy | heuristic-tilted: attack > play > move > heal > cube > pass |
| Value backup | from a fixed-perspective viewpoint across the full tree |

## Training features (v2)

| Feature | Value |
|---|---|
| LR schedule | Cosine annealing (lr → min_lr over all epochs) |
| Gradient clip | max_norm = 1.0 |
| Validation split | 10 % held out |
| Metrics | Policy loss, value MSE, **top-1 policy accuracy** |
| Best checkpoint | saved when val_loss improves |
| Resume | `--resume <ckpt>` to continue from a prior run |

## AlphaZero loop (alphazero.py)

```
for iteration in 1..N:
    1. Self-play:  generate games using best model (or MCTS on iter 1)
                   → append to replay buffer (FIFO, max_buffer samples)
    2. Train:      supervised on full replay buffer, starting from best weights
    3. Evaluate:   candidate vs best over eval_games games (alternating sides)
    4. Promote:    if win_rate > threshold (default 55 %), replace best model
```

## Design notes

- **State cloning** swaps the game logger for a `_NoopLogger` before
  `copy.deepcopy()` to avoid pickling Python logging thread locks.
- **Randomness** is handled by determinization: each MCTS simulation clones
  the state (including its RNG), so the draw deck is fixed within a
  simulation but varies across simulations.
- **Move action encoding**: `action_type="move"`, `hand_index=from_cell_idx`
  (= fy×W + fx), `board_x=to_x`, `board_y=to_y`.  The 3-step dispatcher
  dance is wrapped transparently in `apply_action`.
- **Self-play multiprocessing**: each worker independently loads the
  checkpoint and runs games. Results are written to the shared JSONL file
  as games complete (file is flushed after each game).

---

## 本地端訓練流程（中文）

完整指南：從零開始訓練到拿到一個能對戰的AI模型。

### 0. 環境準備

所有指令都在 `FOS brainstorming/` 資料夾下執行（就是 `main.py` 所在的資料夾）。

```bash
cd "FOS brainstorming"
```

安裝依賴：

```bash
# 遊戲本體
pip install -r requirements.txt

# AI訓練（torch、numpy）
pip install -r ai/requirements.txt
```

> **GPU**：有CUDA的話 `torch` 會自動使用。沒GPU也能跑，只是訓練慢一點。
> **CPU 核數**：自我對弈用 `--workers` 平行跑，建議設成你CPU實體核心數。

---

### 1. 冒煙測試（30秒，確認環境OK）

跑一場 MCTS vs 隨機 對戰，看到winner就代表全部能跑：

```bash
python -m ai.play_match --p1 mcts --p2 random --sims 100
```

預期輸出：
```
winner=player1 score=-11 turns=11
```

---

### 2. 第一階段：純MCTS蒐集初始資料

第一輪沒有訓練好的模型，先用純MCTS自我對弈來產生資料。

```bash
python -m ai.self_play \
    --games 50 \
    --sims 200 \
    --workers 4 \
    --max-turns 120 \
    --temp-cutoff 10 \
    --out data/iter0.jsonl
```

**參數說明：**

| 參數 | 意義 | 建議 |
|---|---|---|
| `--games` | 要跑幾場 | 起步 50–100，正式 500+ |
| `--sims` | 每步MCTS模擬次數（越多越強，但越慢） | 200 起步，500 進階 |
| `--workers` | 平行進程數 | CPU實體核心數 |
| `--max-turns` | 單場上限（避免無限長） | 120 |
| `--temp-cutoff` | 前幾回合用 τ=1 隨機抽樣 | 10 |
| `--out` | 資料輸出檔（JSONL格式） | 自訂 |

預期：
- 50場大約 5–15分鐘（依CPU、--sims而定）
- 產出檔約 1000–5000筆樣本（每筆是一個決策點）

---

### 3. 第二階段：訓練第一個policy/value網路

```bash
python -m ai.train \
    --data data/iter0.jsonl \
    --epochs 30 \
    --batch-size 256 \
    --lr 1e-3 \
    --out checkpoints/iter1.pt
```

**訓練輸出長這樣：**

```
[train] samples=2483 input_dim=124 action_dim=369
[train] epoch   1 | trn loss=5.4 pol=4.8 val_err=0.55 acc=8.3% | val loss=5.5 ... acc=10.2% | lr=9.95e-04
[train] epoch  10 | trn loss=3.2 pol=2.9 val_err=0.30 acc=42.1% | val loss=3.6 ... acc=38.5% | lr=2.50e-04
...
[train]  ↑ best val_loss=3.45 — saved to checkpoints/iter1.pt
```

**怎麼看訓練好不好：**
- `policy accuracy`（top-1）：模型猜對MCTS最佳動作的比例。**>30%** 算可用，**>50%** 算強。
- `value MSE` (`val_err`)：勝負預測誤差。**<0.5** 算合理。
- `val loss` 持續下降代表沒過擬合。

---

### 4. 第三階段：用訓好的網路強化MCTS（PUCT）

把 `iter1.pt` 當作MCTS的policy prior再跑一輪自我對弈，這次資料品質更高：

```bash
python -m ai.self_play \
    --games 50 \
    --sims 300 \
    --workers 4 \
    --checkpoint checkpoints/iter1.pt \
    --append \
    --out data/iter0.jsonl
```

**重點：**
- `--checkpoint` 載入訓好的模型 → MCTS改用PUCT，搜索品質提升
- `--append` 把新資料**追加**到舊檔（不要覆寫）
- `--sims` 可以開更高（300+），因為PUCT效率更好

---

### 5. 第四階段：用累積資料再訓練

```bash
python -m ai.train \
    --data data/iter0.jsonl \
    --resume checkpoints/iter1.pt \
    --epochs 20 \
    --out checkpoints/iter2.pt
```

`--resume` 讓模型從上一輪權重繼續，不從頭訓練。

---

### 6. 自動化：用 AlphaZero 完整循環

上面 2→3→4→5 的循環，`alphazero.py` 都幫你做了：

```bash
python -m ai.alphazero \
    --iterations 10 \
    --games-per-iter 30 \
    --sims 300 \
    --epochs 15 \
    --eval-games 20 \
    --promote-threshold 0.55 \
    --max-buffer 50000 \
    --out-dir runs/az_run1
```

**它會做什麼：**
1. **第1輪**：純MCTS跑30場 → 訓練 → 評估 vs 純MCTS → 通過就升級為 `best.pt`
2. **第2輪起**：用上一輪的 `best.pt` 當PUCT prior 跑30場 → 訓練 → 對戰 `best.pt` → 勝率>55%才升級
3. **重複10輪**

**輸出結構：**
```
runs/az_run1/
├── replay.jsonl              # 累積的訓練資料（FIFO，最多50k筆）
├── candidate_iter001.pt      # 每輪訓練產出
├── candidate_iter002.pt
├── ...
└── best.pt                   # 目前最強模型（推薦使用）
```

**訓練時間估計（4核CPU）：**

| 配置 | 每輪時間 | 10輪總時 |
|---|---|---|
| games=20, sims=200, epochs=10 | 5–10分 | 1–2小時 |
| games=30, sims=300, epochs=15 | 15–25分 | 2.5–4小時 |
| games=50, sims=500, epochs=20 | 40–60分 | 7–10小時 |

---

### 7. 使用訓練好的AI

```python
from ai.bot import PolicyBot

bot = PolicyBot("runs/az_run1/best.pt")
action = bot.pick(game_state, player="player1")
```

或在command line測試強度：

```bash
# 訓練好的AI vs 純MCTS
python -c "
import sys; sys.path.insert(0, '.')
from ai.play_match import play
from ai.bot import PolicyBot, MCTSBot
trained = PolicyBot('runs/az_run1/best.pt')
baseline = MCTSBot(simulations=300)
wins = 0
for i in range(20):
    if i % 2 == 0:
        w, _ = play(trained, baseline, seed=i)
        if w == 'player1': wins += 1
    else:
        w, _ = play(baseline, trained, seed=i)
        if w == 'player2': wins += 1
print(f'勝率：{wins}/20 = {wins*5}%')
"
```

---

### 8. 監控與除錯

**訓練不收斂？**
- 加大 `--games-per-iter`：資料太少
- 加大 `--sims`：MCTS太弱，產出標籤雜訊高
- 降低 `--lr`（試 5e-4）：學習率太高震盪

**自我對弈超慢？**
- 開 `--workers` 平行
- 降 `--sims` 到 100–200
- 降 `--max-turns` 到 80

**模型一直無法升級（候選總是輸）？**
- 降 `--promote-threshold` 到 0.52
- 加大 `--epochs` 訓練更久
- 加大 `--games-per-iter` 收更多資料

**看訓練資料分布：**
```bash
python -c "
import json
samples = [json.loads(l) for l in open('runs/az_run1/replay.jsonl')]
print(f'總筆數: {len(samples)}')
from collections import Counter
print(f'勝負: {Counter(s[\"value\"] for s in samples)}')
print(f'p1樣本: {sum(1 for s in samples if s[\"perspective\"]==\"player1\")}')
"
```

---

### 9. 推薦實戰流程（懶人版）

第一次玩，直接跑這個就對了：

```bash
# Step 1: 環境
cd "FOS brainstorming"
pip install -r requirements.txt
pip install -r ai/requirements.txt

# Step 2: 冒煙測試
python -m ai.play_match --p1 mcts --p2 random --sims 100

# Step 3: 跑 AlphaZero 訓練（過夜跑，用 nohup 背景執行）
nohup python -m ai.alphazero \
    --iterations 15 \
    --games-per-iter 30 \
    --sims 300 \
    --epochs 15 \
    --eval-games 20 \
    --out-dir runs/main \
    > training.log 2>&1 &

# Step 4: 看進度
tail -f training.log

# Step 5: 訓練完用 best.pt 對戰
python -m ai.play_match --p1 mcts --p2 mcts --sims 300  # 比賽
```

**完成！** `runs/main/best.pt` 就是你的AI。

