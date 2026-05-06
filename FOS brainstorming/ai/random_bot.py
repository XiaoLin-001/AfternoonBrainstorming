"""Random baseline opponent for benchmarking."""
from __future__ import annotations

import random
from typing import Optional

from core.game_action import GameAction
from core.game_state import GameState

from .action_space import legal_actions
from .state_utils import current_player


class RandomBot:
    def __init__(self, seed: Optional[int] = None):
        self.rng = random.Random(seed)

    def pick(self, game_state: GameState, player: Optional[str] = None) -> Optional[GameAction]:
        player = player or current_player(game_state)
        actions = legal_actions(game_state, player)
        if not actions:
            return None
        non_pass = [a for a in actions if a.action_type != "end_turn"]
        if non_pass and self.rng.random() < 0.85:
            return self.rng.choice(non_pass)
        return self.rng.choice(actions)
