"""Monte Carlo Tree Search over BattlingDispatcher — v2.

Improvements over v1:
  - Refactored into a single _simulate() method shared by search() and
    search_with_visits() (eliminates duplicate code).
  - Dirichlet noise at root for exploration during self-play.
  - Optional PUCT selection (AlphaZero-style) via policy_fn argument:
    pass a callable (state, player) -> List[float] to use policy priors.
    Without it, falls back to standard UCT with uniform priors.
  - Temperature-weighted action sampling in search_with_visits (τ=1 for
    proportional sampling, τ→0 for greedy selection).
  - Heuristic-tilted rollout: attack > play_card > move > heal > cube > pass.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Tuple

from core.battling_dispatcher import BattlingDispatcher
from core.game_action import GameAction
from core.game_state import GameState

from .action_space import apply_action, legal_actions
from .heuristic import evaluate
from .state_utils import clone_state, current_player, is_terminal, reward_for


PolicyFn = Callable[[GameState, str], List[float]]  # state, player → priors[ACTION_DIM]


@dataclass
class MCTSNode:
    parent: Optional["MCTSNode"]
    action: Optional[GameAction]
    to_move: str
    prior: float = 1.0          # policy prior (PUCT); 1.0 = uniform (UCT)
    untried: List[GameAction] = field(default_factory=list)
    children: List["MCTSNode"] = field(default_factory=list)
    visits: int = 0
    value_sum: float = 0.0      # from root-perspective

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
        policy_fn: Optional[PolicyFn] = None,
        dirichlet_alpha: float = 0.3,
        dirichlet_eps: float = 0.25,
    ) -> None:
        self.simulations = simulations
        self.c = c_puct
        self.rollout_depth = rollout_depth
        self.max_turns = max_turns
        self.perspective = perspective
        self.rng = random.Random(seed)
        self.policy_fn = policy_fn
        self.dirichlet_alpha = dirichlet_alpha
        self.dirichlet_eps = dirichlet_eps

    # ------------------------------------------------------------------
    # Selection score (PUCT / UCT unified)
    # ------------------------------------------------------------------
    def _score(self, child: MCTSNode, parent: MCTSNode, perspective: str) -> float:
        q = child.q_root if parent.to_move == perspective else -child.q_root
        u = self.c * child.prior * math.sqrt(parent.visits + 1) / (1 + child.visits)
        return q + u

    # ------------------------------------------------------------------
    # Dirichlet helpers
    # ------------------------------------------------------------------
    def _dirichlet(self, n: int) -> List[float]:
        samples = [self.rng.gammavariate(self.dirichlet_alpha, 1.0) for _ in range(n)]
        total = sum(samples) or 1.0
        return [s / total for s in samples]

    # ------------------------------------------------------------------
    # Prior assignment for a set of actions
    # ------------------------------------------------------------------
    def _priors_for(self, state: GameState, player: str, actions: List[GameAction]) -> List[float]:
        n = len(actions)
        if n == 0:
            return []
        if self.policy_fn is None:
            return [1.0 / n] * n
        from .policy_net import action_to_index
        all_p = self.policy_fn(state, player)
        raw = []
        for a in actions:
            idx = action_to_index(a)
            raw.append(max(all_p[idx] if idx is not None and idx < len(all_p) else 0.0, 1e-8))
        total = sum(raw)
        return [p / total for p in raw]

    # ------------------------------------------------------------------
    # Core: run all simulations, return the populated root node
    # ------------------------------------------------------------------
    def _simulate(self, root_state: GameState, perspective: str, add_noise: bool) -> MCTSNode:
        init_acts = legal_actions(root_state, current_player(root_state))
        init_priors = self._priors_for(root_state, current_player(root_state), init_acts)

        if add_noise and self.dirichlet_eps > 0 and init_acts:
            noise = self._dirichlet(len(init_acts))
            eps = self.dirichlet_eps
            init_priors = [(1 - eps) * p + eps * n for p, n in zip(init_priors, noise)]

        root = MCTSNode(parent=None, action=None, to_move=current_player(root_state))
        root.untried = list(init_acts)
        root._init_priors: dict[int, float] = {  # type: ignore[attr-defined]
            id(a): p for a, p in zip(init_acts, init_priors)
        }

        for _ in range(self.simulations):
            state = clone_state(root_state)
            dispatcher = BattlingDispatcher(state, mode="local")
            node = root

            # --- selection ---
            while not node.untried and node.children and not is_terminal(state, self.max_turns):
                node = max(node.children, key=lambda ch: self._score(ch, node, perspective))
                apply_action(dispatcher, state, node.action)

            # --- expansion ---
            if not is_terminal(state, self.max_turns) and node.untried:
                # random choice preserves tree diversity
                idx = self.rng.randrange(len(node.untried))
                action = node.untried.pop(idx)

                # prior for this action
                if node is root:
                    prior = root._init_priors.get(id(action), 1.0 / max(len(init_acts), 1))  # type: ignore[attr-defined]
                else:
                    prior = getattr(node, "_child_priors", {}).get(id(action), 1.0 / max(len(node.untried) + 1, 1))

                apply_action(dispatcher, state, action)

                child_acts = (
                    legal_actions(state, current_player(state))
                    if not is_terminal(state, self.max_turns)
                    else []
                )
                child_priors = self._priors_for(state, current_player(state), child_acts)

                child = MCTSNode(
                    parent=node,
                    action=action,
                    to_move=current_player(state),
                    prior=prior,
                    untried=list(child_acts),
                )
                child._child_priors = {id(a): p for a, p in zip(child_acts, child_priors)}  # type: ignore[attr-defined]
                node.children.append(child)
                node = child

            # --- rollout ---
            steps = 0
            while not is_terminal(state, self.max_turns) and steps < self.rollout_depth:
                acts = legal_actions(state, current_player(state))
                if not acts:
                    break
                a = self._rollout_policy(state, acts)
                apply_action(dispatcher, state, a)
                steps += 1

            value = (
                reward_for(state, perspective, self.max_turns)
                if is_terminal(state, self.max_turns)
                else evaluate(state, perspective)
            )

            # --- backup ---
            cur: Optional[MCTSNode] = node
            while cur is not None:
                cur.visits += 1
                cur.value_sum += value
                cur = cur.parent

        return root

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def search(self, root_state: GameState, add_noise: bool = False) -> Optional[GameAction]:
        perspective = self.perspective or current_player(root_state)
        root = self._simulate(root_state, perspective, add_noise)
        if not root.children:
            return root.untried[0] if root.untried else None
        return max(root.children, key=lambda ch: ch.visits).action

    def search_with_visits(
        self,
        root_state: GameState,
        temperature: float = 1.0,
        add_noise: bool = True,
    ) -> Tuple[Optional[GameAction], List[Tuple[GameAction, int]]]:
        """Return (best_action, [(action, visit_count), ...]) for all root children.

        temperature=1.0: sample ∝ visit counts (exploratory).
        temperature→0 : greedy argmax on visit counts.
        add_noise=True : mix Dirichlet noise at root (use during self-play).
        """
        perspective = self.perspective or current_player(root_state)
        root = self._simulate(root_state, perspective, add_noise)
        visits = [(ch.action, ch.visits) for ch in root.children]

        if not visits:
            fallback = root.untried[0] if root.untried else None
            return fallback, []

        if temperature < 1e-3:
            chosen = max(root.children, key=lambda ch: ch.visits).action
        else:
            counts = [ch.visits ** (1.0 / temperature) for ch in root.children]
            total = sum(counts) or 1.0
            probs = [c / total for c in counts]
            r = self.rng.random()
            acc = 0.0
            chosen = root.children[-1].action
            for ch, p in zip(root.children, probs):
                acc += p
                if r <= acc:
                    chosen = ch.action
                    break

        return chosen, visits

    def _rollout_policy(self, state: GameState, actions: List[GameAction]) -> GameAction:
        weights = {
            "attack":     3.0,
            "play_card":  3.0,
            "heal":       2.5,
            "spawn_cube": 2.0,
            "move":       1.5,
            "end_turn":   0.3,
        }
        wts = [weights.get(a.action_type, 1.0) for a in actions]
        total = sum(wts)
        r = self.rng.random() * total
        acc = 0.0
        for a, w in zip(actions, wts):
            acc += w
            if r <= acc:
                return a
        return actions[-1]
