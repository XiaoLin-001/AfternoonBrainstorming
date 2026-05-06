# AI for Afternoon Brainstorming

MCTS-based decision engine for the card game, with a full AlphaZero-style
distillation pipeline: self-play → supervised training → evaluation → iterate.

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
