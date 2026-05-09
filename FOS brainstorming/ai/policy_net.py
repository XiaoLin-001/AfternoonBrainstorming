"""Tiny policy/value network for distilling MCTS results.

Action index layout (fixed-size ACTION_DIM = 433):
  [0]                                 end_turn
  [1 .. 16]                           attack(cell)          (CELLS = 16)
  [17 .. 144]                         play_card(hand, cell) (HAND_SLOTS * CELLS = 128)
  [145 .. 160]                        heal(cell)            (CELLS = 16)
  [161 .. 176]                        spawn_cube(cell)      (CELLS = 16)
  [177 .. 432]                        move(from_cell, to_cell) (CELLS*CELLS = 256)

HAND_SLOTS bumped from 4 → 8 to cover the real maximum hand size; with
HAND_SLOTS=4 every play_card targeting hand[4..7] was silently dropped.
"""
from __future__ import annotations

from typing import List, Optional

try:
    import torch
    from torch import nn
    HAS_TORCH = True
except ImportError:
    torch = None  # type: ignore
    nn = None  # type: ignore
    HAS_TORCH = False

from core.game_action import GameAction


BOARD_W = 4
BOARD_H = 4
CELLS = BOARD_W * BOARD_H   # 16
HAND_SLOTS = 8

_BASE_END   = 0
_BASE_ATK   = 1
_BASE_PLAY  = _BASE_ATK  + CELLS               # 17
_BASE_HEAL  = _BASE_PLAY + HAND_SLOTS * CELLS  # 145
_BASE_CUBE  = _BASE_HEAL + CELLS               # 161
_BASE_MOVE  = _BASE_CUBE + CELLS               # 177
ACTION_DIM  = _BASE_MOVE + CELLS * CELLS       # 433


def action_to_index(action: GameAction) -> Optional[int]:
    t = action.action_type
    x = action.board_x or 0
    y = action.board_y or 0
    cell = y * BOARD_W + x

    if t == "end_turn":
        return _BASE_END
    if t == "attack":
        return _BASE_ATK + cell
    if t == "play_card":
        h = action.hand_index or 0
        if h >= HAND_SLOTS:
            return None
        return _BASE_PLAY + h * CELLS + cell
    if t == "heal":
        return _BASE_HEAL + cell
    if t == "spawn_cube":
        return _BASE_CUBE + cell
    if t == "move":
        from_idx = action.hand_index or 0
        return _BASE_MOVE + from_idx * CELLS + cell
    return None


def index_to_action(idx: int, player: str) -> Optional[GameAction]:
    if idx == _BASE_END:
        return GameAction(player=player, action_type="end_turn")
    if _BASE_ATK <= idx < _BASE_PLAY:
        cell = idx - _BASE_ATK
        return GameAction(player=player, action_type="attack",
                          board_x=cell % BOARD_W, board_y=cell // BOARD_W)
    if _BASE_PLAY <= idx < _BASE_HEAL:
        rel = idx - _BASE_PLAY
        h, cell = rel // CELLS, rel % CELLS
        return GameAction(player=player, action_type="play_card",
                          hand_index=h, board_x=cell % BOARD_W, board_y=cell // BOARD_W)
    if _BASE_HEAL <= idx < _BASE_CUBE:
        cell = idx - _BASE_HEAL
        return GameAction(player=player, action_type="heal",
                          board_x=cell % BOARD_W, board_y=cell // BOARD_W)
    if _BASE_CUBE <= idx < _BASE_MOVE:
        cell = idx - _BASE_CUBE
        return GameAction(player=player, action_type="spawn_cube",
                          board_x=cell % BOARD_W, board_y=cell // BOARD_W)
    if _BASE_MOVE <= idx < ACTION_DIM:
        rel = idx - _BASE_MOVE
        from_cell, to_cell = rel // CELLS, rel % CELLS
        return GameAction(player=player, action_type="move",
                          hand_index=from_cell,
                          board_x=to_cell % BOARD_W, board_y=to_cell // BOARD_W)
    return None


def visits_to_target(visits_pairs: List[tuple[GameAction, int]]) -> List[float]:
    """Convert MCTS visit counts into a length-ACTION_DIM soft target."""
    target = [0.0] * ACTION_DIM
    total = sum(v for _, v in visits_pairs) or 1
    for action, v in visits_pairs:
        idx = action_to_index(action)
        if idx is None:
            continue
        target[idx] += v / total
    return target


if HAS_TORCH:
    class PolicyValueNet(nn.Module):
        """Three-layer MLP with separate policy and value heads.

        Architecture (v2): batch norm + residual skip in trunk for faster
        convergence with small datasets.
        """

        def __init__(self, input_dim: int, hidden: int = 256, action_dim: int = ACTION_DIM):
            super().__init__()
            self.fc1 = nn.Linear(input_dim, hidden)
            self.bn1 = nn.BatchNorm1d(hidden)
            self.fc2 = nn.Linear(hidden, hidden)
            self.bn2 = nn.BatchNorm1d(hidden)
            self.skip = nn.Linear(input_dim, hidden)  # residual projection
            self.policy_head = nn.Linear(hidden, action_dim)
            self.value_head = nn.Sequential(
                nn.Linear(hidden, 64),
                nn.ReLU(),
                nn.Linear(64, 1),
                nn.Tanh(),
            )
            self.act = nn.ReLU()

        def forward(self, x):
            h = self.act(self.bn1(self.fc1(x)))
            h = self.act(self.bn2(self.fc2(h)) + self.skip(x))
            return self.policy_head(h), self.value_head(h).squeeze(-1)

        def policy_probs(self, x, legal_mask, temperature: float = 1.0):
            """Masked softmax over legal actions for PUCT."""
            logits, value = self.forward(x)
            scaled = logits / max(temperature, 1e-6)
            neg_inf = torch.full_like(scaled, float("-inf"))
            masked = torch.where(legal_mask, scaled, neg_inf)
            return torch.softmax(masked, dim=-1), value


def masked_softmax(logits, mask, temperature: float = 1.0):
    if not HAS_TORCH:
        raise RuntimeError("torch not installed")
    scaled = logits / max(temperature, 1e-6)
    neg_inf = torch.full_like(scaled, float("-inf"))
    return torch.softmax(torch.where(mask, scaled, neg_inf), dim=-1)
