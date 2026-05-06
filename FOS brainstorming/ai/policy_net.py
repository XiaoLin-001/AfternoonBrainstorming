"""Tiny policy/value network for distilling MCTS results.

Action representation: we encode an action as a category index over a
small discrete set:
    0..H-1                    : end_turn (1) + per-cell special slots
    end_turn_idx              : 0
    attack(x,y)               : 1 + (y * W + x)
    play_card(idx, x, y)      : 1 + W*H + (hand_idx * W*H) + (y*W + x)   for HAND_SLOTS
    heal(x, y)                : 1 + W*H + HAND_SLOTS*W*H + (y*W + x)
    spawn_cube(x, y)          : 1 + 2*W*H + HAND_SLOTS*W*H + (y*W + x)

The network outputs logits over this fixed action space. At inference time
we mask out illegal actions before taking softmax.
"""
from __future__ import annotations

from typing import List, Optional

try:
    import torch
    from torch import nn
    HAS_TORCH = True
except ImportError:  # torch is optional — MCTS works without it.
    torch = None  # type: ignore
    nn = None  # type: ignore
    HAS_TORCH = False

from core.game_action import GameAction


BOARD_W = 4
BOARD_H = 4
CELLS = BOARD_W * BOARD_H
HAND_SLOTS = 4

ACTION_DIM = 1 + CELLS + HAND_SLOTS * CELLS + CELLS + CELLS  # 1+16+64+16+16 = 113


def action_to_index(action: GameAction) -> Optional[int]:
    t = action.action_type
    x = action.board_x or 0
    y = action.board_y or 0
    cell = y * BOARD_W + x
    if t == "end_turn":
        return 0
    if t == "attack":
        return 1 + cell
    if t == "play_card":
        h = action.hand_index or 0
        if h >= HAND_SLOTS:
            return None
        return 1 + CELLS + h * CELLS + cell
    if t == "heal":
        return 1 + CELLS + HAND_SLOTS * CELLS + cell
    if t == "spawn_cube":
        return 1 + CELLS + HAND_SLOTS * CELLS + CELLS + cell
    return None


def index_to_action(idx: int, player: str) -> Optional[GameAction]:
    if idx == 0:
        return GameAction(player=player, action_type="end_turn")
    base = 1
    if idx < base + CELLS:
        cell = idx - base
        return GameAction(player=player, action_type="attack",
                          board_x=cell % BOARD_W, board_y=cell // BOARD_W)
    base += CELLS
    if idx < base + HAND_SLOTS * CELLS:
        rel = idx - base
        h = rel // CELLS
        cell = rel % CELLS
        return GameAction(player=player, action_type="play_card",
                          hand_index=h, board_x=cell % BOARD_W, board_y=cell // BOARD_W)
    base += HAND_SLOTS * CELLS
    if idx < base + CELLS:
        cell = idx - base
        return GameAction(player=player, action_type="heal",
                          board_x=cell % BOARD_W, board_y=cell // BOARD_W)
    base += CELLS
    if idx < base + CELLS:
        cell = idx - base
        return GameAction(player=player, action_type="spawn_cube",
                          board_x=cell % BOARD_W, board_y=cell // BOARD_W)
    return None


if HAS_TORCH:
    class PolicyValueNet(nn.Module):
        def __init__(self, input_dim: int, hidden: int = 256, action_dim: int = ACTION_DIM):
            super().__init__()
            self.trunk = nn.Sequential(
                nn.Linear(input_dim, hidden),
                nn.ReLU(),
                nn.Linear(hidden, hidden),
                nn.ReLU(),
            )
            self.policy_head = nn.Linear(hidden, action_dim)
            self.value_head = nn.Sequential(
                nn.Linear(hidden, 64),
                nn.ReLU(),
                nn.Linear(64, 1),
                nn.Tanh(),
            )

        def forward(self, x):
            h = self.trunk(x)
            return self.policy_head(h), self.value_head(h).squeeze(-1)


def masked_softmax(logits, mask, temperature: float = 1.0):
    """Softmax over only the indices marked True in `mask` (1-D tensors)."""
    if not HAS_TORCH:
        raise RuntimeError("torch not installed — cannot run policy net")
    scaled = logits / max(temperature, 1e-6)
    very_negative = torch.full_like(scaled, float("-inf"))
    masked = torch.where(mask, scaled, very_negative)
    return torch.softmax(masked, dim=-1)


def visits_to_target(visits_pairs: List[tuple[GameAction, int]]) -> List[float]:
    """Convert MCTS visit counts into a length-ACTION_DIM target distribution."""
    target = [0.0] * ACTION_DIM
    total = sum(v for _, v in visits_pairs) or 1
    for action, v in visits_pairs:
        idx = action_to_index(action)
        if idx is None:
            continue
        target[idx] += v / total
    return target
