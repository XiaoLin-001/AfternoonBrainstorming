# AI for Afternoon Brainstorming

MCTS-based decision engine for the card game, plus a distillation pipeline
that trains a small policy/value network from MCTS self-play.

## Why MCTS

The game is turn-based and `BattlingDispatcher` already provides a complete,
serializable simulator. That makes MCTS the natural fit:

- `clone_state(game_state)` produces a deep copy you can roll forward freely.
- `BattlingDispatcher(state, mode="local").dispatch(action, state)` advances
  the cloned state by one action.
- Game ends when `abs(score) >= 10`.

The MCTS perspective scoring uses the same convention as the dispatcher:
negative score = `player1` winning, positive = `player2` winning.

## Layout

| File | Purpose |
|---|---|
| `state_utils.py` | Clone state, current player, terminal check, reward |
| `action_space.py` | Enumerate legal `GameAction`s (attack / play / heal / cube / end_turn) |
| `heuristic.py` | Leaf evaluation when rollouts cut off |
| `mcts.py` | UCT search with heuristic-tilted random rollouts |
| `encode.py` | `GameState` → fixed-length feature vector |
| `policy_net.py` | Tiny policy/value MLP + action-index encoding |
| `random_bot.py` | Random baseline opponent |
| `bot.py` | `MCTSBot` and `PolicyBot` inference wrappers |
| `play_match.py` | Run a single bot-vs-bot game |
| `self_play.py` | Generate `(features, policy, value)` trajectories with MCTS |
| `train.py` | Distill the trajectories into a network |

## Quick start

All commands assume cwd = `FOS brainstorming/` (the directory that contains
`main.py`).

### 1. Smoke test — MCTS vs random

```bash
python -m ai.play_match --p1 mcts --p2 random --sims 200 --verbose
```

### 2. Generate self-play data

```bash
python -m ai.self_play --games 50 --sims 200 --out data/selfplay.jsonl
```

More games + more sims = stronger teacher. Start small to validate end-to-end.

### 3. Train the distilled network

```bash
pip install torch
python -m ai.train --data data/selfplay.jsonl --epochs 30 \
    --out checkpoints/policy.pt
```

### 4. Use the trained net

```python
from ai.bot import PolicyBot
bot = PolicyBot("checkpoints/policy.pt")
action = bot.pick(game_state, player="player1")
```

If torch or the checkpoint is missing, `PolicyBot` automatically falls back
to `MCTSBot`.

## Design notes & known limitations

- **Movement is not in the action space.** The dispatcher's `move_to` is a
  three-click selection dance (mark moving → select card → click destination)
  that needs a macro-action wrapper. Strategy is still meaningful without it,
  but adding it later is a clear win — wrap the three dispatches behind a
  single `MoveAction(from_x, from_y, to_x, to_y)`.
- **Randomness via determinization.** The simulator's RNG is part of the
  cloned state, so each MCTS simulation rolls forward with the seed it was
  cloned with. For stronger play under heavy randomness, average across N
  re-determinizations of the root state.
- **Action space is fixed-size for the policy net.** 4×4 board × at most 4
  hand slots × 5 action types = 113 indices. If `BoardConfig` or the hand
  size grows, update `BOARD_W`, `BOARD_H`, and `HAND_SLOTS` in
  `policy_net.py`.
- **Self-play is single-process.** For real training scale, wrap
  `play_one_game` in `multiprocessing.Pool`.
- **Value targets are end-of-game.** AlphaZero-style. With more compute,
  bootstrap from the network's own value head (TD-style).

## Where this can go next

- Replace the random rollout policy in `mcts._rollout_policy` with the
  trained network's policy head → AlphaZero loop.
- Add a `MoveAction` macro and re-train.
- Plug `MCTSBot` into the game's `battling.main` as a third player mode
  alongside `local` / `lan_server` / `lan_client`.
