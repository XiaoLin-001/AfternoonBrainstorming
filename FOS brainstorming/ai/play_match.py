"""Run a single game between two bots and return the winner.

Usage from `FOS brainstorming/`:
    python -m ai.play_match --p1 mcts --p2 random --sims 200
"""
from __future__ import annotations

import argparse
import random
from typing import Callable, Optional

from cards.factory import CardFactory
from core.battling_dispatcher import BattlingDispatcher
from core.board_config import BoardConfig
from core.game_state import GameState
from core.neutral import Neutral
from core.player import Player
from utils.logger import GameLogger

from .action_space import apply_action
from .bot import MCTSBot
from .random_bot import RandomBot
from .state_utils import current_player, is_terminal, winner


CardFactory.register_all()


DEFAULT_DECK = [
    "ADCW", "TANKW", "ASSW", "HFW", "LFW", "APTW", "SPW", "APW",
    "HEAL", "MOVE", "CUBES", "ADCW",
]

# Richer deck that exercises move actions (MOVE card adds number_of_movings)
MOVE_DECK = [
    "ADCW", "TANKW", "ASSW", "HFW", "LFW", "APTW", "SPW", "APW",
    "HEAL", "MOVE", "MOVE", "CUBES",
]


def _silent() -> GameLogger:
    return GameLogger(enable_file=False, enable_console=False, enable_jsonl=False)


def make_game(
    deck1: Optional[list[str]] = None,
    deck2: Optional[list[str]] = None,
    seed: Optional[int] = None,
) -> GameState:
    deck1 = list(deck1 or DEFAULT_DECK)
    deck2 = list(deck2 or DEFAULT_DECK)
    p1 = Player(name="player1", deck=deck1, hand=[], on_board=[], draw_pile=[], discard_pile=[])
    p2 = Player(name="player2", deck=deck2, hand=[], on_board=[], draw_pile=[], discard_pile=[])
    state = GameState(
        p1, p2, Neutral(), BoardConfig(),
        game_logger=_silent(),
        rng_seed=seed if seed is not None else random.randint(0, 2**31 - 1),
    )
    from core.board_block import Board
    cfg = state.board_config
    for y in range(cfg.height):
        for x in range(cfg.width):
            state.board_dict[x, y] = Board(
                width=64, height=64, occupy=False, color=(255, 255, 255),
                board_x=x, board_y=y,
            )
    p1.initialize(state)
    p2.initialize(state)
    return state


def play(
    bot1, bot2,
    max_turns: int = 200,
    seed: Optional[int] = None,
    verbose: bool = False,
    on_step: Optional[Callable[[GameState, "GameAction"], None]] = None,  # type: ignore[name-defined]
) -> tuple[Optional[str], GameState]:
    state = make_game(seed=seed)
    dispatcher = BattlingDispatcher(state, mode="local")

    bots = {"player1": bot1, "player2": bot2}
    safety_steps = 0
    while not is_terminal(state, max_turns):
        if safety_steps > max_turns * 50:
            break
        cur = current_player(state)
        action = bots[cur].pick(state, cur)
        if action is None:
            break
        if verbose:
            print(f"turn={state.turn_number} {cur} -> {action.action_type}"
                  f" x={action.board_x} y={action.board_y} h={action.hand_index}"
                  f" score={state.score}")
        apply_action(dispatcher, state, action)
        if on_step is not None:
            on_step(state, action)
        safety_steps += 1
    return winner(state, max_turns), state


def _build_bot(name: str, sims: int):
    name = name.lower()
    if name == "random":
        return RandomBot()
    if name in ("mcts", "ai"):
        return MCTSBot(simulations=sims)
    raise SystemExit(f"unknown bot: {name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--p1", default="mcts")
    ap.add_argument("--p2", default="random")
    ap.add_argument("--sims", type=int, default=200)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    bot1 = _build_bot(args.p1, args.sims)
    bot2 = _build_bot(args.p2, args.sims)
    win, state = play(bot1, bot2, seed=args.seed, verbose=args.verbose)
    print(f"winner={win} score={state.score} turns={state.turn_number}")


if __name__ == "__main__":
    main()
