"""MCTS-based AI for Afternoon Brainstorming.

Modules:
  state_utils  - state cloning, terminal/winner checks
  action_space - legal action enumeration
  heuristic    - leaf evaluation
  mcts         - Monte Carlo Tree Search
  encode       - state -> feature tensor
  policy_net   - PyTorch policy/value network
  self_play    - generate (state, mcts_pi, value) trajectories
  train        - supervised distillation of MCTS into a small net
  bot          - inference: pick best action for current state
  random_bot   - baseline opponent
  play_match   - run a game between two bots
"""
