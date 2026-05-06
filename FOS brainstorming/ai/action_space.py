"""Legal action enumeration and execution helpers."""
from __future__ import annotations

from typing import List

from core.game_action import GameAction, ActionResult
from core.game_state import GameState
from core.battling_dispatcher import BattlingDispatcher


MAGIC_HAND_TARGETS = ("HEAL", "MOVE", "MOVEO", "CUBES")


def legal_actions(game_state: GameState, player: str) -> List[GameAction]:
    """Return high-level legal actions for `player` at the current state.

    Note: card movement (the multi-step `move_to` selection dance) is
    intentionally omitted from v1 — it requires three coordinated dispatcher
    calls that the AI would have to model as a macro action. Attack, play_card,
    heal, spawn_cube, and end_turn already cover the interesting strategy.
    """
    actions: List[GameAction] = []
    p = game_state.get_player(player)
    cfg = game_state.board_config

    actions.append(GameAction(player=player, action_type="end_turn"))

    if game_state.number_of_attacks[player] > 0:
        for card in p.on_board:
            if not card.numbness:
                actions.append(GameAction(
                    player=player, action_type="attack",
                    board_x=card.board_x, board_y=card.board_y,
                ))

    for idx, name in enumerate(p.hand):
        if name in MAGIC_HAND_TARGETS:
            actions.append(GameAction(
                player=player, action_type="play_card",
                hand_index=idx, board_x=0, board_y=0,
            ))
        else:
            for x in range(cfg.width):
                for y in range(cfg.height):
                    block = game_state.board_dict.get((x, y))
                    if block is not None and not block.occupy:
                        actions.append(GameAction(
                            player=player, action_type="play_card",
                            hand_index=idx, board_x=x, board_y=y,
                        ))

    if game_state.number_of_heals[player] > 0:
        for card in p.on_board:
            if card.health < card.max_health:
                actions.append(GameAction(
                    player=player, action_type="heal",
                    board_x=card.board_x, board_y=card.board_y,
                ))

    if game_state.number_of_cubes[player] > 0:
        for x in range(cfg.width):
            for y in range(cfg.height):
                block = game_state.board_dict.get((x, y))
                if block is not None and not block.occupy:
                    actions.append(GameAction(
                        player=player, action_type="spawn_cube",
                        board_x=x, board_y=y,
                    ))

    return actions


def action_key(action: GameAction) -> tuple:
    """Hashable key — stable identifier for lookup tables (e.g. policy targets)."""
    return (action.action_type, action.board_x, action.board_y, action.hand_index)


def apply_action(dispatcher: BattlingDispatcher, game_state: GameState, action: GameAction) -> ActionResult:
    return dispatcher.dispatch(action, game_state)
