"""High-level inference: given a GameState, return the best GameAction.

Two flavours:
  - MCTSBot: pure MCTS, no neural net required.
  - PolicyBot: trained policy net (used when torch is available and a
    checkpoint has been saved by `train.py`). When ``mcts_simulations`` > 0
    the bot uses MCTS with the network as PUCT prior; when 0 it falls back
    to plain argmax over network logits.
"""
from __future__ import annotations

from typing import List, Optional

from core.game_action import GameAction
from core.game_state import GameState

from .action_space import legal_actions
from .mcts import MCTS
from .state_utils import current_player


class MCTSBot:
    def __init__(self, simulations: int = 400, rollout_depth: int = 25, seed: Optional[int] = None):
        self.simulations = simulations
        self.rollout_depth = rollout_depth
        self.seed = seed

    def pick(self, game_state: GameState, player: Optional[str] = None) -> Optional[GameAction]:
        player = player or current_player(game_state)
        mcts = MCTS(
            simulations=self.simulations,
            rollout_depth=self.rollout_depth,
            perspective=player,
            seed=self.seed,
        )
        return mcts.search(game_state)


class PolicyBot:
    """Inference using a trained policy network. Falls back to MCTS if torch
    or the checkpoint is missing.

    Set ``mcts_simulations`` > 0 to wrap the network in PUCT-MCTS at
    inference time — typically much stronger than raw argmax."""

    def __init__(
        self,
        checkpoint_path: str,
        fallback_simulations: int = 200,
        mcts_simulations: int = 0,
        rollout_depth: int = 20,
    ):
        self._fallback = MCTSBot(simulations=fallback_simulations)
        self._mcts_sims = mcts_simulations
        self._rollout_depth = rollout_depth
        self._net = None
        self._input_dim = None
        self._policy_fn = None
        try:
            import torch  # noqa: F401
            from .policy_net import PolicyValueNet
            from .encode import feature_dim, encode_state
            import torch as _torch
            ckpt = _torch.load(checkpoint_path, map_location="cpu")
            self._input_dim = ckpt.get("input_dim", feature_dim())
            self._net = PolicyValueNet(input_dim=self._input_dim)
            self._net.load_state_dict(ckpt["model_state"])
            self._net.eval()

            net = self._net

            def _policy_fn(state, perspective):
                feats = encode_state(state, perspective)
                x = _torch.tensor(feats, dtype=_torch.float32).unsqueeze(0)
                with _torch.no_grad():
                    logits, _ = net(x)
                probs = _torch.softmax(logits[0], dim=-1)
                return probs.tolist()
            self._policy_fn = _policy_fn
        except Exception as e:
            print(f"[PolicyBot] using MCTS fallback ({e!r})")
            self._net = None

    def pick(self, game_state: GameState, player: Optional[str] = None) -> Optional[GameAction]:
        player = player or current_player(game_state)
        if self._net is None:
            return self._fallback.pick(game_state, player)

        if self._mcts_sims > 0 and self._policy_fn is not None:
            mcts = MCTS(
                simulations=self._mcts_sims,
                rollout_depth=self._rollout_depth,
                perspective=player,
                policy_fn=self._policy_fn,
                dirichlet_eps=0.0,
            )
            return mcts.search(game_state)

        import torch
        from .encode import encode_state
        from .policy_net import action_to_index

        feats = encode_state(game_state, player)
        x = torch.tensor(feats, dtype=torch.float32).unsqueeze(0)
        with torch.no_grad():
            logits, _value = self._net(x)
        logits = logits[0]

        legal = legal_actions(game_state, player)
        if not legal:
            return None

        best_action = None
        best_logit = float("-inf")
        for a in legal:
            idx = action_to_index(a)
            if idx is None:
                continue
            v = float(logits[idx])
            if v > best_logit:
                best_logit = v
                best_action = a
        return best_action or legal[0]
