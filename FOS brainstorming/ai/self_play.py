"""Generate self-play trajectories with MCTS for distillation — v2.

Improvements over v1:
  - Temperature annealing: τ=1 for the first `--temp-cutoff` turns,
    τ→0 after that (greedy), matching AlphaZero training practice.
  - Dirichlet noise enabled at root by default during self-play.
  - Optional policy network prior: loads a checkpoint and uses its policy
    head as MCTS priors (PUCT mode) for stronger self-play once a model
    exists.
  - Multiprocessing: --workers N runs N games in parallel via
    multiprocessing.Pool.
  - Appends to the output file rather than overwriting, so iterations
    can accumulate data progressively.

Usage from `FOS brainstorming/`:
    python -m ai.self_play --games 50 --sims 200 --out data/selfplay.jsonl
    python -m ai.self_play --games 20 --sims 300 --checkpoint checkpoints/policy.pt \\
        --workers 4 --out data/selfplay.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path
from typing import List, Optional, Tuple

try:
    from tqdm import tqdm
except ImportError:
    def tqdm(it, **kw):  # type: ignore[misc]
        return it

from core.battling_dispatcher import BattlingDispatcher

from .action_space import apply_action
from .encode import encode_state, feature_dim
from .mcts import MCTS, PolicyFn
from .play_match import make_game
from .policy_net import action_to_index, visits_to_target, ACTION_DIM
from .state_utils import current_player, is_terminal, reward_for, winner


def _build_policy_fn(checkpoint_path: str) -> Optional[PolicyFn]:
    """Return a callable (state, player) → List[float] from a checkpoint."""
    try:
        import torch
        from .policy_net import PolicyValueNet
        from .encode import feature_dim as fdim
        ckpt = torch.load(checkpoint_path, map_location="cpu")
        net = PolicyValueNet(input_dim=ckpt.get("input_dim", fdim()))
        net.load_state_dict(ckpt["model_state"])
        net.eval()

        def policy_fn(state, player) -> List[float]:
            feats = encode_state(state, player)
            x = torch.tensor(feats, dtype=torch.float32).unsqueeze(0)
            with torch.no_grad():
                logits, _ = net(x)
            probs = torch.softmax(logits[0], dim=-1)
            return probs.tolist()

        return policy_fn
    except Exception as e:
        print(f"[selfplay] could not load policy_fn ({e}), using uniform priors", file=sys.stderr)
        return None


def play_one_game(
    simulations: int,
    rollout_depth: int,
    max_turns: int,
    temp_cutoff: int = 10,
    seed: Optional[int] = None,
    policy_fn: Optional[PolicyFn] = None,
    dirichlet_alpha: float = 0.3,
    dirichlet_eps: float = 0.25,
    show_progress: bool = False,
) -> Tuple[List[dict], Optional[str]]:
    state = make_game(seed=seed)
    dispatcher = BattlingDispatcher(state, mode="local")
    samples: List[dict] = []

    safety = 0
    turn_bar = tqdm(total=max_turns, desc="  Turns", unit="turn", leave=False, disable=not show_progress)
    while not is_terminal(state, max_turns):
        if safety > max_turns * 50:
            break
        cur = current_player(state)
        temperature = 1.0 if state.turn_number < temp_cutoff else 0.0

        mcts = MCTS(
            simulations=simulations,
            rollout_depth=rollout_depth,
            perspective=cur,
            max_turns=max_turns,
            seed=random.randint(0, 2**31 - 1),
            policy_fn=policy_fn,
            dirichlet_alpha=dirichlet_alpha,
            dirichlet_eps=dirichlet_eps,
        )
        chosen, visit_pairs = mcts.search_with_visits(
            state,
            temperature=temperature,
            add_noise=True,
        )
        if chosen is None:
            break

        samples.append({
            "perspective":   cur,
            "features":      encode_state(state, cur),
            "policy":        visits_to_target(visit_pairs),
            "chosen_index":  action_to_index(chosen),
        })

        apply_action(dispatcher, state, chosen)
        safety += 1
        if show_progress:
            turn_bar.update(1)
            turn_bar.set_postfix(player=cur, action=str(chosen)[:20] if chosen else "")

    turn_bar.close()
    final_v_p1 = reward_for(state, "player1", max_turns)
    for s in samples:
        s["value"] = final_v_p1 if s["perspective"] == "player1" else -final_v_p1

    return samples, winner(state, max_turns)


def _worker_init() -> None:
    """Suppress pygame banner in worker processes."""
    import os
    os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")


def _worker_task(args_tuple) -> Tuple[List[dict], Optional[str], int]:
    """Top-level function required by multiprocessing.Pool."""
    (sims, depth, max_turns, temp_cutoff, seed,
     checkpoint, d_alpha, d_eps) = args_tuple
    policy_fn = _build_policy_fn(checkpoint) if checkpoint else None
    samples, win = play_one_game(
        simulations=sims,
        rollout_depth=depth,
        max_turns=max_turns,
        temp_cutoff=temp_cutoff,
        seed=seed,
        policy_fn=policy_fn,
        dirichlet_alpha=d_alpha,
        dirichlet_eps=d_eps,
    )
    return samples, win, seed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games",        type=int,   default=10)
    ap.add_argument("--sims",         type=int,   default=200)
    ap.add_argument("--rollout-depth",type=int,   default=20)
    ap.add_argument("--max-turns",    type=int,   default=120)
    ap.add_argument("--temp-cutoff",  type=int,   default=10,
                    help="use τ=1 for this many turns, then τ→0")
    ap.add_argument("--out",          default="data/selfplay.jsonl")
    ap.add_argument("--append",       action="store_true",
                    help="append to --out instead of overwriting")
    ap.add_argument("--seed",         type=int,   default=None)
    ap.add_argument("--checkpoint",   default=None,
                    help="policy checkpoint for PUCT priors")
    ap.add_argument("--workers",      type=int,   default=1,
                    help="parallel game workers (multiprocessing)")
    ap.add_argument("--dirichlet-alpha", type=float, default=0.3)
    ap.add_argument("--dirichlet-eps",   type=float, default=0.25)
    args = ap.parse_args()

    Path(os.path.dirname(args.out) or ".").mkdir(parents=True, exist_ok=True)
    rng_seed = args.seed if args.seed is not None else random.randint(0, 2**31 - 1)
    rng = random.Random(rng_seed)
    seeds = [rng.randint(0, 2**31 - 1) for _ in range(args.games)]

    mode = "a" if args.append else "w"
    total_samples = 0
    win_counts: dict[str, int] = {"player1": 0, "player2": 0, "draw": 0}

    worker_args = [
        (args.sims, args.rollout_depth, args.max_turns, args.temp_cutoff,
         seed, args.checkpoint, args.dirichlet_alpha, args.dirichlet_eps)
        for seed in seeds
    ]

    with open(args.out, mode, encoding="utf-8") as f:
        if args.workers > 1:
            import multiprocessing as mp
            with mp.Pool(processes=args.workers, initializer=_worker_init) as pool:
                game_bar = tqdm(pool.imap_unordered(_worker_task, worker_args),
                                total=args.games, desc="Games", unit="game")
                for g, (samples, win, seed) in enumerate(game_bar):
                    for s in samples:
                        f.write(json.dumps(s) + "\n")
                    f.flush()
                    total_samples += len(samples)
                    key = win if win in ("player1", "player2") else "draw"
                    win_counts[key] += 1
                    game_bar.set_postfix(winner=win or "draw", samples=len(samples),
                                         p1=win_counts["player1"], p2=win_counts["player2"])
                    print(f"[selfplay] game {g+1}/{args.games} winner={win} "
                          f"samples={len(samples)} (seed={seed})")
        else:
            policy_fn = _build_policy_fn(args.checkpoint) if args.checkpoint else None
            game_bar = tqdm(enumerate(worker_args), total=args.games, desc="Games", unit="game")
            for g, task in game_bar:
                sims, depth, max_turns, temp_cutoff, seed, _ckpt, d_alpha, d_eps = task
                samples, win = play_one_game(
                    simulations=sims, rollout_depth=depth, max_turns=max_turns,
                    temp_cutoff=temp_cutoff, seed=seed, policy_fn=policy_fn,
                    dirichlet_alpha=d_alpha, dirichlet_eps=d_eps, show_progress=True,
                )
                for s in samples:
                    f.write(json.dumps(s) + "\n")
                f.flush()
                total_samples += len(samples)
                key = win if win in ("player1", "player2") else "draw"
                win_counts[key] += 1
                game_bar.set_postfix(winner=win or "draw", samples=len(samples),
                                     p1=win_counts["player1"], p2=win_counts["player2"])
                print(f"[selfplay] game {g+1}/{args.games} winner={win} "
                      f"samples={len(samples)} (seed={seed})")

    print(f"[selfplay] done. total_samples={total_samples} wins={win_counts}")
    print(f"[selfplay] feature_dim={feature_dim()} action_dim={ACTION_DIM}")


if __name__ == "__main__":
    main()
