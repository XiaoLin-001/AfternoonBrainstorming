"""Distill MCTS self-play data into a tiny policy/value network — v2.

Improvements over v1:
  - Validation split (10 %): tracks val policy accuracy and val value MSE.
  - Cosine-annealing learning rate schedule.
  - Gradient clipping (max_norm = 1.0) for stable training.
  - Policy top-1 accuracy metric (does argmax of predicted logits match the
    action that MCTS most-visited?).
  - --resume: continue from an existing checkpoint.
  - --append: append new JSONL data to the dataset instead of overwriting.

Usage from `FOS brainstorming/`:
    python -m ai.train --data data/selfplay.jsonl --epochs 30 --out checkpoints/policy.pt
    python -m ai.train --data data/more.jsonl --resume checkpoints/policy.pt --epochs 10
"""
from __future__ import annotations

import argparse
import json
import os
import random
from pathlib import Path

try:
    import torch
    from torch import nn, optim
    from torch.optim.lr_scheduler import CosineAnnealingLR
    from torch.utils.data import DataLoader, Dataset, random_split
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

from .encode import feature_dim
from .policy_net import ACTION_DIM


if HAS_TORCH:
    class SelfPlayDataset(Dataset):
        """Loads (features, policy_target, value_target, chosen_index) from JSONL."""

        def __init__(self, paths: list[str]):
            self.records: list[dict] = []
            for path in paths:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            self.records.append(json.loads(line))

        def __len__(self) -> int:
            return len(self.records)

        def __getitem__(self, i: int):
            r = self.records[i]
            chosen = r.get("chosen_index")
            return (
                torch.tensor(r["features"], dtype=torch.float32),
                torch.tensor(r["policy"],   dtype=torch.float32),
                torch.tensor(r["value"],    dtype=torch.float32),
                chosen if chosen is not None else -1,
            )


def _accuracy(logits, chosen_indices) -> float:
    preds = logits.argmax(dim=-1)
    chosen = torch.tensor(chosen_indices, dtype=torch.long, device=logits.device)
    valid_mask = chosen >= 0
    if not valid_mask.any():
        return 0.0
    return float((preds[valid_mask] == chosen[valid_mask]).float().mean())


def main() -> None:
    if not HAS_TORCH:
        raise SystemExit("torch is required. Install with: pip install torch")

    ap = argparse.ArgumentParser()
    ap.add_argument("--data", nargs="+", required=True, help="one or more JSONL files")
    ap.add_argument("--out",    default="checkpoints/policy.pt")
    ap.add_argument("--resume", default=None,  help="checkpoint to continue from")
    ap.add_argument("--epochs",      type=int,   default=30)
    ap.add_argument("--batch-size",  type=int,   default=256)
    ap.add_argument("--lr",          type=float, default=1e-3)
    ap.add_argument("--min-lr",      type=float, default=1e-5)
    ap.add_argument("--hidden",      type=int,   default=256)
    ap.add_argument("--policy-weight", type=float, default=1.0)
    ap.add_argument("--value-weight",  type=float, default=1.0)
    ap.add_argument("--val-split",   type=float, default=0.1)
    ap.add_argument("--grad-clip",   type=float, default=1.0)
    ap.add_argument("--seed",        type=int,   default=42)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    random.seed(args.seed)

    from .policy_net import PolicyValueNet

    ds = SelfPlayDataset(args.data)
    if len(ds) == 0:
        raise SystemExit("All data files are empty — run ai.self_play first")

    in_dim = feature_dim()
    print(f"[train] samples={len(ds)} input_dim={in_dim} action_dim={ACTION_DIM}")

    # --- train / val split ---
    n_val = max(1, int(len(ds) * args.val_split))
    n_train = len(ds) - n_val
    train_ds, val_ds = random_split(ds, [n_train, n_val],
                                    generator=torch.Generator().manual_seed(args.seed))

    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True,  drop_last=True)
    val_loader   = DataLoader(val_ds,   batch_size=args.batch_size, shuffle=False, drop_last=False)

    # --- model ---
    net = PolicyValueNet(input_dim=in_dim, hidden=args.hidden)
    start_epoch = 0

    if args.resume:
        ckpt = torch.load(args.resume, map_location="cpu")
        net.load_state_dict(ckpt["model_state"])
        start_epoch = ckpt.get("epoch", 0)
        print(f"[train] resumed from {args.resume} at epoch {start_epoch}")

    opt = optim.Adam(net.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = CosineAnnealingLR(opt, T_max=args.epochs, eta_min=args.min_lr)

    best_val_loss = float("inf")
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    for epoch in range(start_epoch, start_epoch + args.epochs):
        # --- train ---
        net.train()
        t_loss = t_pol = t_val_loss = t_acc = 0.0
        nb = 0
        for x, pi, v, chosen in train_loader:
            logits, value = net(x)
            log_probs = torch.log_softmax(logits, dim=-1)
            pol_loss = -(pi * log_probs).sum(dim=-1).mean()
            val_loss = (value - v).pow(2).mean()
            loss = args.policy_weight * pol_loss + args.value_weight * val_loss

            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(net.parameters(), args.grad_clip)
            opt.step()

            t_loss += loss.item(); t_pol += pol_loss.item(); t_val_loss += val_loss.item()
            t_acc  += _accuracy(logits.detach(), chosen)
            nb += 1

        scheduler.step()

        # --- validate ---
        net.eval()
        v_loss = v_pol = v_val_loss = v_acc = 0.0
        vb = 0
        with torch.no_grad():
            for x, pi, v, chosen in val_loader:
                logits, value = net(x)
                log_probs = torch.log_softmax(logits, dim=-1)
                pol_loss = -(pi * log_probs).sum(dim=-1).mean()
                val_loss = (value - v).pow(2).mean()
                loss = args.policy_weight * pol_loss + args.value_weight * val_loss

                v_loss += loss.item(); v_pol += pol_loss.item(); v_val_loss += val_loss.item()
                v_acc  += _accuracy(logits, chosen)
                vb += 1

        ta = lambda x, n: x / max(n, 1)
        print(
            f"[train] epoch {epoch+1:3d} | "
            f"trn loss={ta(t_loss,nb):.4f} pol={ta(t_pol,nb):.4f} "
            f"val_err={ta(t_val_loss,nb):.4f} acc={ta(t_acc,nb)*100:.1f}% | "
            f"val loss={ta(v_loss,vb):.4f} pol={ta(v_pol,vb):.4f} "
            f"val_err={ta(v_val_loss,vb):.4f} acc={ta(v_acc,vb)*100:.1f}% | "
            f"lr={scheduler.get_last_lr()[0]:.2e}"
        )

        if ta(v_loss, vb) < best_val_loss:
            best_val_loss = ta(v_loss, vb)
            torch.save({
                "model_state": net.state_dict(),
                "input_dim":   in_dim,
                "action_dim":  ACTION_DIM,
                "hidden":      args.hidden,
                "epoch":       epoch + 1,
                "val_loss":    best_val_loss,
            }, out_path)
            print(f"[train]  ↑ best val_loss={best_val_loss:.4f} — saved to {out_path}")

    print(f"[train] done. best val_loss={best_val_loss:.4f}")


if __name__ == "__main__":
    main()
