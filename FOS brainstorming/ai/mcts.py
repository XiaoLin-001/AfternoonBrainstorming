"""Monte Carlo Tree Search over BattlingDispatcher.

Two-player zero-sum UCT:
  - Node values are stored from a fixed root perspective.
  - During selection, parents pick children that maximise value from the
    parent's `to_move` viewpoint (sign-flipped if not the root perspective).
  - Randomness in the simulator is handled by determinization: we clone the
    state per simulation, so each rollout sees a fresh draw of the RNG.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import List, Optional

from core.battling_dispatcher import BattlingDispatcher
from core.game_action import GameAction
from core.game_state import GameState

from .action_space import apply_action, legal_actions
from .heuristic import evaluate
from .state_utils import (
    clone_state,
    current_player,
    is_terminal,
    reward_for,
)


@dataclass
class MCTSNode:
    parent: Optional["MCTSNode"]
    action: Optional[GameAction]
    to_move: str
    untried: List[GameAction] = field(default_factory=list)
    children: List["MCTSNode"] = field(default_factory=list)
    visits: int = 0
    value_sum: float = 0.0  # stored from root perspective

    @property
    def q_root(self) -> float:
        return self.value_sum / self.visits if self.visits else 0.0


class MCTS:
    def __init__(
        self,
        simulations: int = 200,
        c_puct: float = 1.4,
        rollout_depth: int = 25,
        max_turns: int = 200,
        perspective: Optional[str] = None,
        seed: Optional[int] = None,
    ) -> None:
        self.simulations = simulations
        self.c = c_puct
        self.rollout_depth = rollout_depth
        self.max_turns = max_turns
        self.perspective = perspective
        self.rng = random.Random(seed)

    def _ucb(self, child: MCTSNode, parent: MCTSNode, perspective: str) -> float:
        if child.visits == 0:
            return float("inf")
        q_for_picker = child.q_root if parent.to_move == perspective else -child.q_root
        return q_for_picker + self.c * math.sqrt(math.log(parent.visits + 1) / child.visits)

    def search(self, root_state: GameState) -> Optional[GameAction]:
        perspective = self.perspective or current_player(root_state)

        root = MCTSNode(
            parent=None,
            action=None,
            to_move=current_player(root_state),
            untried=legal_actions(root_state, current_player(root_state)),
        )

        for _ in range(self.simulations):
            state = clone_state(root_state)
            dispatcher = BattlingDispatcher(state, mode="local")
            node = root

            while not node.untried and node.children and not is_terminal(state, self.max_turns):
                node = max(node.children, key=lambda ch: self._ucb(ch, node, perspective))
                apply_action(dispatcher, state, node.action)

            if not is_terminal(state, self.max_turns) and node.untried:
                action = self.rng.choice(node.untried)
                node.untried.remove(action)
                apply_action(dispatcher, state, action)
                child_actions = (
                    legal_actions(state, current_player(state))
                    if not is_terminal(state, self.max_turns)
                    else []
                )
                child = MCTSNode(
                    parent=node,
                    action=action,
                    to_move=current_player(state),
                    untried=child_actions,
                )
                node.children.append(child)
                node = child

            steps = 0
            while not is_terminal(state, self.max_turns) and steps < self.rollout_depth:
                acts = legal_actions(state, current_player(state))
                if not acts:
                    break
                a = self._rollout_policy(state, acts)
                apply_action(dispatcher, state, a)
                steps += 1

            if is_terminal(state, self.max_turns):
                value = reward_for(state, perspective, self.max_turns)
            else:
                value = evaluate(state, perspective)

            cur: Optional[MCTSNode] = node
            while cur is not None:
                cur.visits += 1
                cur.value_sum += value
                cur = cur.parent

        if not root.children:
            return None
        return max(root.children, key=lambda ch: ch.visits).action

    def _rollout_policy(self, state: GameState, actions: List[GameAction]) -> GameAction:
        """Heuristic-tilted random rollout: prefer attacks and unit plays."""
        weights = []
        for a in actions:
            if a.action_type == "attack":
                weights.append(4.0)
            elif a.action_type == "play_card":
                weights.append(2.0)
            elif a.action_type == "heal":
                weights.append(1.5)
            elif a.action_type == "spawn_cube":
                weights.append(1.0)
            elif a.action_type == "end_turn":
                weights.append(0.4)
            else:
                weights.append(1.0)
        total = sum(weights)
        r = self.rng.random() * total
        acc = 0.0
        for a, w in zip(actions, weights):
            acc += w
            if r <= acc:
                return a
        return actions[-1]

    def search_with_visits(self, root_state: GameState) -> tuple[Optional[GameAction], List[tuple[GameAction, int]]]:
        """Variant that returns the chosen action along with visit counts per child.

        Used by self-play to record the MCTS policy distribution for distillation.
        """
        perspective = self.perspective or current_player(root_state)

        root = MCTSNode(
            parent=None,
            action=None,
            to_move=current_player(root_state),
            untried=legal_actions(root_state, current_player(root_state)),
        )

        for _ in range(self.simulations):
            state = clone_state(root_state)
            dispatcher = BattlingDispatcher(state, mode="local")
            node = root

            while not node.untried and node.children and not is_terminal(state, self.max_turns):
                node = max(node.children, key=lambda ch: self._ucb(ch, node, perspective))
                apply_action(dispatcher, state, node.action)

            if not is_terminal(state, self.max_turns) and node.untried:
                action = self.rng.choice(node.untried)
                node.untried.remove(action)
                apply_action(dispatcher, state, action)
                child_actions = (
                    legal_actions(state, current_player(state))
                    if not is_terminal(state, self.max_turns)
                    else []
                )
                child = MCTSNode(
                    parent=node,
                    action=action,
                    to_move=current_player(state),
                    untried=child_actions,
                )
                node.children.append(child)
                node = child

            steps = 0
            while not is_terminal(state, self.max_turns) and steps < self.rollout_depth:
                acts = legal_actions(state, current_player(state))
                if not acts:
                    break
                a = self._rollout_policy(state, acts)
                apply_action(dispatcher, state, a)
                steps += 1

            if is_terminal(state, self.max_turns):
                value = reward_for(state, perspective, self.max_turns)
            else:
                value = evaluate(state, perspective)

            cur: Optional[MCTSNode] = node
            while cur is not None:
                cur.visits += 1
                cur.value_sum += value
                cur = cur.parent

        if not root.children:
            return None, []
        visits = [(ch.action, ch.visits) for ch in root.children]
        best = max(root.children, key=lambda ch: ch.visits).action
        return best, visits
