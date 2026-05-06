"""Distill MCTS self-play data into a tiny policy/value network.

Usage from `FOS brainstorming/`:
    python -m ai.train --data data/selfplay.jsonl --epochs 20 --out checkpoints/policy.pt
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path

try:
    import torch
    from torch import nn, optim
    from torch.utils.data import DataLoader, Dataset
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

from .encode import feature_dim
from .policy_net import ACTION_DIM


if HAS_TORCH:
    class SelfPlayDataset(Dataset):
        def __init__(self, jsonl_path: str):
            self.records = []
            with open(jsonl_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    self.records.append(json.loads(line))

        def __len__(self):
            return len(self.records)

        def __getitem__(self, i):
            r = self.records[i]
            return (
                torch.tensor(r["features"], dtype=torch.float32),
                torch.tensor(r["policy"], dtype=torch.float32),
                torch.tensor(r["value"], dtype=torch.float32),
            )


def main() -> None:
    if not HAS_TORCH:
        raise SystemExit(
            "torch is required for training. Install with: pip install torch"
        )

    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default="checkpoints/policy.pt")
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--batch-size", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--hidden", type=int, default=256)
    ap.add_argument("--policy-weight", type=float, default=1.0)
    ap.add_argument("--value-weight", type=float, default=1.0)
    args = ap.parse_args()

    from .policy_net import PolicyValueNet

    ds = SelfPlayDataset(args.data)
    if len(ds) == 0:
        raise SystemExit("self-play file is empty — run ai.self_play first")

    in_dim = feature_dim()
    print(f"[train] samples={len(ds)} input_dim={in_dim} action_dim={ACTION_DIM}")

    loader = DataLoader(ds, batch_size=args.batch_size, shuffle=True, drop_last=False)
    net = PolicyValueNet(input_dim=in_dim, hidden=args.hidden)
    opt = optim.Adam(net.parameters(), lr=args.lr)

    for epoch in range(args.epochs):
        total_loss = 0.0
        total_pol = 0.0
        total_val = 0.0
        n_batches = 0
        for x, pi, v in loader:
            logits, value = net(x)
            log_probs = torch.log_softmax(logits, dim=-1)
            policy_loss = -(pi * log_probs).sum(dim=-1).mean()
            value_loss = (value - v).pow(2).mean()
            loss = args.policy_weight * policy_loss + args.value_weight * value_loss

            opt.zero_grad()
            loss.backward()
            opt.step()

            total_loss += float(loss.item())
            total_pol += float(policy_loss.item())
            total_val += float(value_loss.item())
            n_batches += 1

        avg = total_loss / max(n_batches, 1)
        ap_p = total_pol / max(n_batches, 1)
        ap_v = total_val / max(n_batches, 1)
        print(f"[train] epoch {epoch+1}/{args.epochs} loss={avg:.4f} "
              f"policy={ap_p:.4f} value={ap_v:.4f}")

    Path(os.path.dirname(args.out) or ".").mkdir(parents=True, exist_ok=True)
    torch.save({
        "model_state": net.state_dict(),
        "input_dim": in_dim,
        "action_dim": ACTION_DIM,
        "hidden": args.hidden,
    }, args.out)
    print(f"[train] saved checkpoint -> {args.out}")


if __name__ == "__main__":
    main()
