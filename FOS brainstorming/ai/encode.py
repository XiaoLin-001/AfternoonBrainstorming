"""Feature encoder: GameState -> fixed-length numerical vector.

Used for distilling MCTS policy/value into a small neural network.
The encoding is intentionally simple and player-relative (everything is
mirrored so that the network always sees "us vs them").

v3 — fixes the major blind spots of v2:
  * per-cell card identity one-hot (so the network can tell ASSW from
    TANKW from LUCKYBLOCK)
  * own-hand multi-count vector (so the network actually sees that it
    holds HEAL / CUBES / MOVE — previously only `len(hand)` was given,
    which made magic-card play unlearnable)
  * `number_of_movings` for both players (was missing entirely)
  * opponent's `number_of_heals` and `number_of_cubes` (was missing)
"""
from __future__ import annotations

from typing import List

from core.game_state import GameState
from cards.base import Card

from .state_utils import current_player, opponent_of


# Card identity vocabularies. Keep in sync with the deck cards used by
# play_match.make_game and any spawnable neutral entities.
CARD_VOCAB: tuple[str, ...] = (
    "ADCW", "TANKW", "ASSW", "HFW", "LFW", "APTW", "SPW", "APW",  # standard attack cards
    "HEAL", "MOVE", "MOVEO", "CUBES",                             # magic / utility cards
)
NEUTRAL_VOCAB: tuple[str, ...] = ("CUBE", "LUCKYBLOCK")
CARD_VOCAB_SIZE = len(CARD_VOCAB)
NEUTRAL_VOCAB_SIZE = len(NEUTRAL_VOCAB)
CELL_ID_DIM = CARD_VOCAB_SIZE + NEUTRAL_VOCAB_SIZE  # 14

CARD_FEATURES_PER_CELL = 7 + CELL_ID_DIM  # 21
GLOBAL_SCALAR_FEATURES = 16
GLOBAL_FEATURES = GLOBAL_SCALAR_FEATURES + CARD_VOCAB_SIZE  # +12 own-hand counts


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


def _card_name_key(name: str) -> str:
    return name[:-4] if name.endswith(" (+)") else name


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

            id_oh = [0.0] * CELL_ID_DIM
            cname = _card_name_key(getattr(card, "job_and_color", "") or "")
            if owner == "neutral":
                if cname in NEUTRAL_VOCAB:
                    id_oh[CARD_VOCAB_SIZE + NEUTRAL_VOCAB.index(cname)] = 1.0
            else:
                if cname in CARD_VOCAB:
                    id_oh[CARD_VOCAB.index(cname)] = 1.0
            feats.extend([is_self, is_opp, is_neu, hp, dmg, numb, mov] + id_oh)

    own_hand_vec = [0.0] * CARD_VOCAB_SIZE
    for cn in game_state.get_player(perspective).hand:
        key = _card_name_key(cn)
        if key in CARD_VOCAB:
            own_hand_vec[CARD_VOCAB.index(key)] += 1.0
    own_hand_vec = [c / 3.0 for c in own_hand_vec]

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
        game_state.number_of_heals[opp] / 3.0,
        game_state.number_of_cubes[perspective] / 3.0,
        game_state.number_of_cubes[opp] / 3.0,
        game_state.number_of_movings[perspective] / 3.0,
        game_state.number_of_movings[opp] / 3.0,
        game_state.players_token[perspective] / 5.0,
        game_state.players_coin.get(perspective, 0) / 5.0,
        game_state.turn_number / 50.0,
    ])
    feats.extend(own_hand_vec)
    return feats


def feature_dim(board_w: int = 4, board_h: int = 4) -> int:
    return board_w * board_h * CARD_FEATURES_PER_CELL + GLOBAL_FEATURES
