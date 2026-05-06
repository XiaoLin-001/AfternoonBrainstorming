"""Leaf evaluation when MCTS rollout/expansion stops at a non-terminal state."""
from __future__ import annotations

from core.game_state import GameState


def evaluate(game_state: GameState, perspective: str) -> float:
    """Heuristic value in [-1, 1] for `perspective`.

    Combines: signed score, total HP delta, unit count delta, hand size.
    Score sign convention from battling_dispatcher: negative = player1 winning.
    """
    score_for_p1 = -game_state.score / 10.0
    score_term = score_for_p1 if perspective == "player1" else -score_for_p1

    p = game_state.get_player(perspective)
    opp = game_state.get_opponent(perspective)

    p_hp = sum(c.health for c in p.on_board)
    opp_hp = sum(c.health for c in opp.on_board)
    p_units = len(p.on_board)
    opp_units = len(opp.on_board)
    p_hand = len(p.hand)
    opp_hand = len(opp.hand)

    material = (p_hp - opp_hp) / 60.0 + (p_units - opp_units) / 6.0
    tempo = (p_hand - opp_hand) / 8.0

    val = 0.55 * score_term + 0.35 * material + 0.10 * tempo
    return max(-1.0, min(1.0, val))
