"""Helpers for cloning GameState and checking terminal/winner conditions."""
from __future__ import annotations

import copy
from typing import Any, Optional

from core.game_state import GameState


class _NoopLogger:
    """Drop-in stand-in for GameLogger during MCTS rollouts.

    The real logger holds a logging.Logger (which carries a thread lock that
    cannot be pickled / deepcopied). We don't need any logging output during
    simulation, so we hand the cloned state a do-nothing logger instead.
    """

    def __getattr__(self, name: str) -> Any:
        def _noop(*args, **kwargs):
            return None
        return _noop


def clone_state(game_state: GameState) -> GameState:
    """Deep copy of GameState with a noop logger swap to avoid thread locks."""
    saved_logger = game_state.game_logger
    game_state.game_logger = _NoopLogger()
    try:
        clone = copy.deepcopy(game_state)
    finally:
        game_state.game_logger = saved_logger
    clone.game_logger = _NoopLogger()
    return clone


def current_player(game_state: GameState) -> str:
    return "player1" if game_state.turn_number % 2 == 0 else "player2"


def opponent_of(player: str) -> str:
    return "player2" if player == "player1" else "player1"


def is_terminal(game_state: GameState, max_turns: int = 200) -> bool:
    if abs(game_state.score) >= 10:
        return True
    if game_state.turn_number >= max_turns:
        return True
    return False


def winner(game_state: GameState, max_turns: int = 200) -> Optional[str]:
    if game_state.score <= -10:
        return "player1"
    if game_state.score >= 10:
        return "player2"
    if game_state.turn_number >= max_turns:
        if game_state.score == 0:
            return None
        return "player1" if game_state.score < 0 else "player2"
    return None


def reward_for(game_state: GameState, perspective: str, max_turns: int = 200) -> float:
    """Terminal reward in [-1, 1] from `perspective`'s point of view."""
    w = winner(game_state, max_turns)
    if w is None:
        score_for_p1 = -game_state.score / 10.0
        v = score_for_p1 if perspective == "player1" else -score_for_p1
        return max(-1.0, min(1.0, v))
    if w == perspective:
        return 1.0
    return -1.0
