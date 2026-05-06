"""Legal action enumeration and execution helpers.

v2: adds move macro actions (from_x/from_y encoded in hand_index as
from_cell = fy*W + fx; board_x/board_y = destination). apply_action
intercepts action_type=="move" and runs the three-step dispatcher sequence
that the UI normally spreads across mouse clicks.
"""
from __future__ import annotations

from typing import List, Optional

from core.game_action import GameAction, ActionResult
from core.game_state import GameState
from core.battling_dispatcher import BattlingDispatcher


MAGIC_HAND_TARGETS = ("HEAL", "MOVE", "MOVEO", "CUBES")

_MOVE_DIRS = [
    (-1, -1), (0, -1), (1, -1),
    (-1,  0),          (1,  0),
    (-1,  1), (0,  1), (1,  1),
]


def _legal_move_macros(game_state: GameState, player: str) -> List[GameAction]:
    """Enumerate valid (from → to) move actions when number_of_movings > 0.

    Encoded as action_type="move", hand_index=from_cell_idx,
    board_x=to_x, board_y=to_y.  from_cell_idx = fy*W + fx.
    """
    if game_state.number_of_movings[player] <= 0:
        return []
    cfg = game_state.board_config
    p = game_state.get_player(player)
    actions: List[GameAction] = []
    for card in p.on_board:
        if card.numbness:
            continue
        cx, cy = card.board_x, card.board_y
        from_idx = cy * cfg.width + cx
        for dx, dy in _MOVE_DIRS:
            tx, ty = cx + dx, cy + dy
            if not cfg.is_valid_position(tx, ty):
                continue
            block = game_state.board_dict.get((tx, ty))
            if block is not None and not block.occupy:
                actions.append(GameAction(
                    player=player,
                    action_type="move",
                    hand_index=from_idx,
                    board_x=tx,
                    board_y=ty,
                ))
    return actions


def legal_actions(game_state: GameState, player: str) -> List[GameAction]:
    """Return high-level legal actions for `player` at the current state."""
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

    actions.extend(_legal_move_macros(game_state, player))

    return actions


def action_key(action: GameAction) -> tuple:
    """Hashable key for policy lookup tables."""
    return (action.action_type, action.board_x, action.board_y, action.hand_index)


def _apply_move_macro(dispatcher: BattlingDispatcher, game_state: GameState, action: GameAction) -> ActionResult:
    """Execute the three-step move dance for action_type=="move".

    hand_index encodes from_cell (fy*W + fx); board_x/board_y is destination.
    """
    cfg = game_state.board_config
    from_idx = action.hand_index or 0
    fx = from_idx % cfg.width
    fy = from_idx // cfg.width
    tx, ty = action.board_x, action.board_y
    p = action.player

    step1 = GameAction(player=p, action_type="move_to", board_x=fx, board_y=fy)
    step2 = GameAction(player=p, action_type="move_to", board_x=fx, board_y=fy)
    step3 = GameAction(player=p, action_type="move_to", board_x=tx, board_y=ty)

    r1 = dispatcher.dispatch(step1, game_state)
    if not r1.success:
        return r1
    r2 = dispatcher.dispatch(step2, game_state)
    if not r2.success:
        return r2
    r3 = dispatcher.dispatch(step3, game_state)
    return r3


def apply_action(dispatcher: BattlingDispatcher, game_state: GameState, action: GameAction) -> ActionResult:
    if action.action_type == "move":
        return _apply_move_macro(dispatcher, game_state, action)
    return dispatcher.dispatch(action, game_state)
