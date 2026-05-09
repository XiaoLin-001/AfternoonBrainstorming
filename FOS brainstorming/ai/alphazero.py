"""AlphaZero-style iterative training loop.

Each iteration:
  1. Self-play: generate N games using the current best model (or random
     MCTS on first iteration) and append trajectories to the replay buffer.
  2. Train: supervised learning on the full replay buffer.
  3. Evaluate: pit the new candidate against the best model over M games.
  4. Promote: replace best with candidate if win rate > threshold.
  5. Repeat.

Usage from `FOS brainstorming/`:
    python -m ai.alphazero \\
        --iterations 10 \\
        --games-per-iter 20 \\
        --sims 200 \\
        --epochs 15 \\
        --eval-games 20 \\
        --out-dir runs/az_v1
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

try:
    from tqdm import tqdm
except ImportError:
    def tqdm(it, **kw):  # type: ignore[misc]
        return it

from core.battling_dispatcher import BattlingDispatcher

from .action_space import apply_action
from .bot import MCTSBot
from .play_match import make_game, play
from .self_play import _build_policy_fn, _worker_init, _worker_task, play_one_game
from .state_utils import is_terminal, winner


def _win_rate(ckpt_new: str, ckpt_old: Optional[str], n_games: int, sims: int,
              eval_sims: int = 0) -> float:
    """Return win rate of ckpt_new vs ckpt_old over n_games (alternating sides)."""
    from .bot import PolicyBot, MCTSBot
    bot_new = PolicyBot(ckpt_new, fallback_simulations=sims, mcts_simulations=eval_sims)
    bot_old = (PolicyBot(ckpt_old, fallback_simulations=sims, mcts_simulations=eval_sims)
               if ckpt_old else MCTSBot(simulations=sims))

    wins = 0
    for g in tqdm(range(n_games), desc="Eval games", unit="game", leave=False):
        if g % 2 == 0:
            b1, b2, new_is_p1 = bot_new, bot_old, True
        else:
            b1, b2, new_is_p1 = bot_old, bot_new, False
        w, _ = play(b1, b2, seed=g, max_turns=120)
        if w is None:
            wins += 0.5  # draw
        elif (w == "player1") == new_is_p1:
            wins += 1
    return wins / n_games


def _generate_selfplay(
    out_file: str,
    n_games: int,
    sims: int,
    depth: int,
    max_turns: int,
    temp_cutoff: int,
    checkpoint: Optional[str],
    d_alpha: float,
    d_eps: float,
    rng: random.Random,
    workers: int = 1,
) -> int:
    """Run n_games self-play games and append samples to out_file."""
    seeds = [rng.randint(0, 2**31 - 1) for _ in range(n_games)]
    total = 0

    if workers > 1:
        import multiprocessing as mp
        worker_args = [
            (sims, depth, max_turns, temp_cutoff, seed, checkpoint, d_alpha, d_eps)
            for seed in seeds
        ]
        with open(out_file, "a", encoding="utf-8") as f:
            with mp.Pool(processes=workers, initializer=_worker_init) as pool:
                game_bar = tqdm(pool.imap_unordered(_worker_task, worker_args),
                                total=n_games, desc="Self-play", unit="game")
                for g, (samples, w, seed) in enumerate(game_bar):
                    for s in samples:
                        f.write(json.dumps(s) + "\n")
                    f.flush()
                    total += len(samples)
                    game_bar.set_postfix(winner=w or "draw", samples=len(samples))
                    print(f"[az selfplay] game {g+1}/{n_games} winner={w} samples={len(samples)} (seed={seed})")
        return total

    policy_fn = _build_policy_fn(checkpoint) if checkpoint else None
    with open(out_file, "a", encoding="utf-8") as f:
        game_bar = tqdm(enumerate(seeds), total=n_games, desc="Self-play", unit="game")
        for g, seed in game_bar:
            samples, w = play_one_game(
                simulations=sims,
                rollout_depth=depth,
                max_turns=max_turns,
                temp_cutoff=temp_cutoff,
                seed=seed,
                policy_fn=policy_fn,
                dirichlet_alpha=d_alpha,
                dirichlet_eps=d_eps,
                show_progress=True,
            )
            for s in samples:
                f.write(json.dumps(s) + "\n")
            f.flush()
            total += len(samples)
            game_bar.set_postfix(winner=w or "draw", samples=len(samples))
            print(f"[az selfplay] game {g+1}/{n_games} winner={w} samples={len(samples)} (seed={seed})")
    return total


def _train(
    data_file: str,
    out_ckpt: str,
    resume: Optional[str],
    epochs: int,
    batch_size: int,
    hidden: int,
    lr: float,
    grad_clip: float,
    policy_weight: float,
    value_weight: float,
) -> None:
    """Run supervised training on data_file → out_ckpt."""
    try:
        import torch
        from .policy_net import PolicyValueNet
        from .encode import feature_dim
        from .train import SelfPlayDataset
        from torch import optim
        from torch.optim.lr_scheduler import CosineAnnealingLR
        from torch.utils.data import DataLoader
        from torch import nn

        ds = SelfPlayDataset([data_file])
        if len(ds) == 0:
            print("[az] no data — skipping training")
            return
        in_dim = feature_dim()
        from .policy_net import ACTION_DIM
        net = PolicyValueNet(input_dim=in_dim, hidden=hidden)
        if resume and Path(resume).exists():
            ckpt = torch.load(resume, map_location="cpu")
            net.load_state_dict(ckpt["model_state"])

        opt = optim.Adam(net.parameters(), lr=lr, weight_decay=1e-4)
        sched = CosineAnnealingLR(opt, T_max=epochs, eta_min=1e-5)
        loader = DataLoader(ds, batch_size=batch_size, shuffle=True, drop_last=True)

        ep_bar = tqdm(range(epochs), desc="  Train epochs", unit="ep", leave=False)
        for ep in ep_bar:
            net.train()
            t_loss = 0.0; nb = 0
            for x, pi, v, chosen in loader:
                logits, value = net(x)
                lp = torch.log_softmax(logits, dim=-1)
                pol_l = -(pi * lp).sum(dim=-1).mean()
                val_l = (value - v).pow(2).mean()
                loss = policy_weight * pol_l + value_weight * val_l
                opt.zero_grad(); loss.backward()
                nn.utils.clip_grad_norm_(net.parameters(), grad_clip)
                opt.step(); t_loss += loss.item(); nb += 1
            sched.step()
            ep_bar.set_postfix(loss=f"{t_loss/max(nb,1):.4f}")
            if (ep + 1) % 5 == 0 or ep == epochs - 1:
                print(f"[az train] epoch {ep+1}/{epochs} loss={t_loss/max(nb,1):.4f}")

        Path(out_ckpt).parent.mkdir(parents=True, exist_ok=True)
        torch.save({
            "model_state": net.state_dict(),
            "input_dim":   in_dim,
            "action_dim":  ACTION_DIM,
            "hidden":      hidden,
        }, out_ckpt)
        print(f"[az train] saved {out_ckpt}")

    except ImportError:
        print("[az] torch not available — cannot train network")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--iterations",    type=int,   default=5)
    ap.add_argument("--games-per-iter",type=int,   default=20)
    ap.add_argument("--sims",          type=int,   default=200)
    ap.add_argument("--rollout-depth", type=int,   default=20)
    ap.add_argument("--max-turns",     type=int,   default=120)
    ap.add_argument("--temp-cutoff",   type=int,   default=10)
    ap.add_argument("--epochs",        type=int,   default=15)
    ap.add_argument("--batch-size",    type=int,   default=256)
    ap.add_argument("--hidden",        type=int,   default=256)
    ap.add_argument("--lr",            type=float, default=1e-3)
    ap.add_argument("--grad-clip",     type=float, default=1.0)
    ap.add_argument("--policy-weight", type=float, default=1.0)
    ap.add_argument("--value-weight",  type=float, default=1.0)
    ap.add_argument("--eval-games",    type=int,   default=20)
    ap.add_argument("--eval-sims",     type=int,   default=0,
                    help="MCTS sims per move during eval (0 = pure argmax)")
    ap.add_argument("--promote-threshold", type=float, default=0.55,
                    help="promote candidate if win_rate > this")
    ap.add_argument("--dirichlet-alpha", type=float, default=0.3)
    ap.add_argument("--dirichlet-eps",   type=float, default=0.25)
    ap.add_argument("--out-dir",       default="runs/alphazero")
    ap.add_argument("--seed",          type=int,   default=None)
    ap.add_argument("--max-buffer",    type=int,   default=100_000,
                    help="max samples kept in replay buffer (FIFO)")
    ap.add_argument("--workers",       type=int,   default=1,
                    help="parallel self-play workers (multiprocessing)")
    ap.add_argument("--fresh",         action="store_true",
                    help="ignore stage markers and rerun every stage from scratch")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    replay_file = str(out_dir / "replay.jsonl")
    best_path = out_dir / "best.pt"
    best_ckpt: Optional[str] = str(best_path) if (not args.fresh and best_path.exists()) else None
    rng = random.Random(args.seed or random.randint(0, 2**31 - 1))

    print(f"[az] starting AlphaZero loop — {args.iterations} iterations")
    print(f"[az] output dir: {out_dir}")
    if best_ckpt:
        print(f"[az] resuming with existing best.pt as prior")

    iter_bar = tqdm(range(1, args.iterations + 1), desc="AlphaZero", unit="iter")
    for it in iter_bar:
        iter_bar.set_description(f"AlphaZero iter {it}/{args.iterations}")
        print(f"\n{'='*60}")
        print(f"[az] ===  ITERATION {it}/{args.iterations}  ===")
        print(f"{'='*60}")

        sp_marker   = out_dir / f"iter{it:03d}.selfplay.done"
        candidate_ckpt = str(out_dir / f"candidate_iter{it:03d}.pt")
        eval_marker = out_dir / f"iter{it:03d}.eval.json"

        # 1. Self-play
        if not args.fresh and sp_marker.exists():
            n_new = json.loads(sp_marker.read_text()).get("samples", 0)
            print(f"[az] [skip] self-play already done ({n_new} samples) — {sp_marker.name}")
        else:
            print(f"[az] self-play: {args.games_per_iter} games, {args.sims} sims, "
                  f"{args.workers} worker(s) ...")
            n_new = _generate_selfplay(
                out_file=replay_file,
                n_games=args.games_per_iter,
                sims=args.sims,
                depth=args.rollout_depth,
                max_turns=args.max_turns,
                temp_cutoff=args.temp_cutoff,
                checkpoint=best_ckpt,
                d_alpha=args.dirichlet_alpha,
                d_eps=args.dirichlet_eps,
                rng=rng,
                workers=args.workers,
            )
            print(f"[az] generated {n_new} new samples")
            _trim_replay(replay_file, args.max_buffer)
            sp_marker.write_text(json.dumps({"samples": n_new, "prior": best_ckpt}))

        # 2. Train
        if not args.fresh and Path(candidate_ckpt).exists():
            print(f"[az] [skip] candidate already exists — {Path(candidate_ckpt).name}")
        else:
            print(f"[az] training {args.epochs} epochs ...")
            _train(
                data_file=replay_file,
                out_ckpt=candidate_ckpt,
                resume=best_ckpt,
                epochs=args.epochs,
                batch_size=args.batch_size,
                hidden=args.hidden,
                lr=args.lr,
                grad_clip=args.grad_clip,
                policy_weight=args.policy_weight,
                value_weight=args.value_weight,
            )
            if not Path(candidate_ckpt).exists():
                print("[az] training produced no checkpoint — keeping current best")
                continue

        # 3. Evaluate + 4. Promote
        if not args.fresh and eval_marker.exists():
            info = json.loads(eval_marker.read_text())
            wr = info.get("win_rate", 0.0)
            promoted = info.get("promoted", False)
            print(f"[az] [skip] eval already done — win_rate={wr*100:.1f}% promoted={promoted}")
            if promoted:
                best_ckpt = str(best_path)
        else:
            print(f"[az] evaluating candidate vs best ({args.eval_games} games) ...")
            wr = _win_rate(candidate_ckpt, best_ckpt, args.eval_games, args.sims,
                           eval_sims=args.eval_sims)
            print(f"[az] candidate win rate = {wr*100:.1f}% (threshold={args.promote_threshold*100:.0f}%)")

            promoted = wr >= args.promote_threshold
            if promoted:
                print(f"[az] PROMOTED candidate → new best")
                best_ckpt = str(best_path)
                shutil.copy2(candidate_ckpt, best_ckpt)
            else:
                print(f"[az] candidate not promoted (win rate too low)")

            eval_marker.write_text(json.dumps({"win_rate": wr, "promoted": promoted}))

    print(f"\n[az] done. best model: {best_ckpt or 'none (pure MCTS)'}")


def _trim_replay(path: str, max_lines: int) -> None:
    """Keep only the last `max_lines` lines of the replay buffer file."""
    p = Path(path)
    if not p.exists():
        return
    lines = p.read_text(encoding="utf-8").splitlines()
    if len(lines) > max_lines:
        p.write_text("\n".join(lines[-max_lines:]) + "\n", encoding="utf-8")
        print(f"[az] trimmed replay buffer to {max_lines} samples")


if __name__ == "__main__":
    main()
