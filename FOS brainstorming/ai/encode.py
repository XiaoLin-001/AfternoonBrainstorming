"""Feature encoder: GameState -> fixed-length numerical vector.

Used for distilling MCTS policy/value into a small neural network.
The encoding is intentionally simple and player-relative (everything is
mirrored so that the network always sees "us vs them").
"""
from __future__ import annotations

from typing import List

from core.game_state import GameState
from cards.base import Card

from .state_utils import current_player, opponent_of


CARD_FEATURES_PER_CELL = 7  # owner_self, owner_opp, owner_neutral, hp_norm, dmg_norm, numbness, moving
GLOBAL_FEATURES = 12


def _card_at(game_state: GameState, x: int, y: int) -> tuple[Card, str] | None:
    for c in game_state.player1.on_board:
        if c.board_x == x and c.board_y == y:
            return c, "player1"
    for c in game_state.player2.on_board:
        if c.board_x == x and c.board_y == y:
            return c, "player2"
    for c in game_state.neutral.on_board:
        if c.board_x == x and c.board_y == y:
            return c, "neutral"
    return None


def encode_state(game_state: GameState, perspective: str | None = None) -> List[float]:
    if perspective is None:
        perspective = current_player(game_state)
    opp = opponent_of(perspective)

    cfg = game_state.board_config
    feats: List[float] = []

    for y in range(cfg.height):
        for x in range(cfg.width):
            entry = _card_at(game_state, x, y)
            if entry is None:
                feats.extend([0.0] * CARD_FEATURES_PER_CELL)
                continue
            card, owner = entry
            is_self = 1.0 if owner == perspective else 0.0
            is_opp = 1.0 if owner == opp else 0.0
            is_neu = 1.0 if owner == "neutral" else 0.0
            hp = max(0.0, card.health) / 20.0
            dmg = getattr(card, "damage", 0) / 10.0
            numb = 1.0 if getattr(card, "numbness", False) else 0.0
            mov = 1.0 if getattr(card, "moving", False) else 0.0
            feats.extend([is_self, is_opp, is_neu, hp, dmg, numb, mov])

    score_for_p1 = -game_state.score / 10.0
    score_term = score_for_p1 if perspective == "player1" else -score_for_p1

    feats.extend([
        score_term,
        len(game_state.get_player(perspective).hand) / 8.0,
        len(game_state.get_opponent(perspective).hand) / 8.0,
        len(game_state.get_player(perspective).on_board) / 6.0,
        len(game_state.get_opponent(perspective).on_board) / 6.0,
        game_state.number_of_attacks[perspective] / 3.0,
        game_state.number_of_attacks[opp] / 3.0,
        game_state.number_of_heals[perspective] / 3.0,
        game_state.number_of_cubes[perspective] / 3.0,
        game_state.players_token[perspective] / 5.0,
        game_state.players_coin.get(perspective, 0) / 5.0,
        game_state.turn_number / 50.0,
    ])
    return feats


def feature_dim(board_w: int = 4, board_h: int = 4) -> int:
    return board_w * board_h * CARD_FEATURES_PER_CELL + GLOBAL_FEATURES
