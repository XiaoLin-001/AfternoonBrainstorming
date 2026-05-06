"""Generate self-play trajectories with MCTS for distillation.

Each saved sample is a tuple:
    (state_features, mcts_policy_target, final_value_for_perspective)

Usage from `FOS brainstorming/`:
    python -m ai.self_play --games 20 --sims 200 --out data/selfplay.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import random
from pathlib import Path
from typing import List, Optional

from core.battling_dispatcher import BattlingDispatcher
from core.game_action import GameAction

from .action_space import apply_action
from .encode import encode_state, feature_dim
from .mcts import MCTS
from .play_match import make_game
from .policy_net import action_to_index, visits_to_target
from .state_utils import current_player, is_terminal, reward_for


def play_one_game(
    simulations: int,
    rollout_depth: int,
    max_turns: int,
    seed: Optional[int] = None,
) -> tuple[List[dict], Optional[str]]:
    state = make_game(seed=seed)
    dispatcher = BattlingDispatcher(state, mode="local")
    samples: List[dict] = []

    safety = 0
    while not is_terminal(state, max_turns):
        if safety > max_turns * 50:
            break
        cur = current_player(state)
        mcts = MCTS(
            simulations=simulations,
            rollout_depth=rollout_depth,
            perspective=cur,
            max_turns=max_turns,
            seed=random.randint(0, 2**31 - 1),
        )
        chosen, visit_pairs = mcts.search_with_visits(state)
        if chosen is None:
            break

        target_pi = visits_to_target(visit_pairs)
        feats = encode_state(state, cur)
        samples.append({
            "perspective": cur,
            "features": feats,
            "policy": target_pi,
            "chosen_index": action_to_index(chosen),
        })

        apply_action(dispatcher, state, chosen)
        safety += 1

    final_value_p1 = reward_for(state, "player1", max_turns)
    for s in samples:
        s["value"] = final_value_p1 if s["perspective"] == "player1" else -final_value_p1

    from .state_utils import winner
    return samples, winner(state, max_turns)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=10)
    ap.add_argument("--sims", type=int, default=200)
    ap.add_argument("--rollout-depth", type=int, default=20)
    ap.add_argument("--max-turns", type=int, default=120)
    ap.add_argument("--out", default="data/selfplay.jsonl")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    Path(os.path.dirname(args.out) or ".").mkdir(parents=True, exist_ok=True)
    rng_seed = args.seed if args.seed is not None else random.randint(0, 2**31 - 1)
    rng = random.Random(rng_seed)

    total_samples = 0
    win_counts = {"player1": 0, "player2": 0, "draw": 0}
    with open(args.out, "w", encoding="utf-8") as f:
        for g in range(args.games):
            game_seed = rng.randint(0, 2**31 - 1)
            samples, win = play_one_game(
                simulations=args.sims,
                rollout_depth=args.rollout_depth,
                max_turns=args.max_turns,
                seed=game_seed,
            )
            for s in samples:
                f.write(json.dumps(s) + "\n")
            total_samples += len(samples)
            key = win if win in ("player1", "player2") else "draw"
            win_counts[key] += 1
            print(f"[selfplay] game {g+1}/{args.games} winner={win} "
                  f"samples={len(samples)} (seed={game_seed})")

    print(f"[selfplay] done. total_samples={total_samples} wins={win_counts}")
    print(f"[selfplay] feature_dim={feature_dim()}")


if __name__ == "__main__":
    main()
