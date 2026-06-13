# -----------------------------------------------------------------
# 實戰助手測試用: 用「真實遊戲引擎」無頭跑一場腳本對局,
# 產生與實戰完全相同格式的 battle_records jsonl。
# 用法: 在 "FOS brainstorming" 目錄下執行
#   python "<此檔路徑>" <輸出資料夾>
# -----------------------------------------------------------------
import os
import sys

sys.path.insert(0, os.getcwd())

from pathlib import Path
from datetime import datetime

from cards.factory import CardFactory
CardFactory.register_all()

from core.game_state import GameState
from core.player import Player
from core.neutral import Neutral
from core.board_block import Board
from core.board_config import BoardConfig
from core.battling_dispatcher import BattlingDispatcher
from core.game_action import GameAction
from utils.logger import GameLogger

OUT_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else "./test_records")
OUT_DIR.mkdir(parents=True, exist_ok=True)
log_path = OUT_DIR / f"{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}_test.log"

DECK1 = ["TANKW", "TANKW", "ADCW", "ADCW", "APW", "HFW", "LFW", "ASSW", "ASSW", "APTW", "SPW", "HFW"]
DECK2 = ["TANKB", "TANKB", "APB", "APB", "ADCB", "ADCB", "ASSB", "ASSB", "SPB", "SPB", "LFB", "LFB"]

logger = GameLogger(log_file=log_path, enable_console=False, enable_file=True, enable_jsonl=True)

board_config = BoardConfig(4, 4)
board_dict = {
    (x, y): Board(width=10, height=10, occupy=False, color=(255, 255, 255), board_x=x, board_y=y)
    for x in range(4) for y in range(4)
}

p1 = Player(name="player1", deck=DECK1, hand=[], on_board=[], draw_pile=[], discard_pile=[])
p2 = Player(name="player2", deck=DECK2, hand=[], on_board=[], draw_pile=[], discard_pile=[])
gs = GameState(player1=p1, player2=p2, neutral=Neutral(on_board=[]),
               board_config=board_config, board_dict=board_dict,
               game_logger=logger, rng_seed=20260611)

# 表頭 (battling.py 開局時寫入的格式)
logger.info("battle start", rng_seed=gs.rng_seed, version="4.0.4.2-test")
logger.info(f"player1 deck {'-'.join(DECK1)}")
logger.info(f"player2 deck {'-'.join(DECK2)}")

p1.initialize(gs)
p2.initialize(gs)

dispatcher = BattlingDispatcher(gs, mode="local")

def act(player, action_type, x=None, y=None, hand_index=None):
    a = GameAction(player=player, action_type=action_type,
                   board_x=x, board_y=y, hand_index=hand_index)
    r = dispatcher._execute(a, gs)
    # 死亡回收 (battling 主迴圈 logic_update 做的事)
    class _R:  # 渲染替身
        dying_cards = []
    for p in (p1, p2):
        p.recycle_cards(gs, _R)
        while gs.card_to_draw[p.name] > 0:
            gs.card_to_draw[p.name] -= 1
            p.draw_card(gs)
    return r

def play_first_unit(player_obj, x, y):
    """放手牌中第一張單位卡到 (x,y)"""
    for i, name in enumerate(player_obj.hand):
        if name not in ("HEAL", "MOVE", "MOVEO", "CUBES"):
            return act(player_obj.name, "play_card", x, y, i)
    return None

# ---- 腳本對局: 約 5 輪,含放置/攻擊/結束 ----
positions = [(0,1),(1,0),(0,0),(2,0),(0,2),(3,0),(1,1),(3,1),(2,2),(0,3),(3,3),(1,3),(2,3),(3,2),(1,2),(2,1)]
pos_i = 0

def next_pos():
    global pos_i
    while pos_i < len(positions):
        x, y = positions[pos_i]; pos_i += 1
        if not gs.board_dict[x, y].occupy:
            return x, y
    return None

for half_turn in range(14):
    cur = p1 if gs.turn_number % 2 == 0 else p2
    # 放 1-2 張
    for _ in range(2):
        pos = next_pos()
        if pos:
            play_first_unit(cur, pos[0], pos[1])
    # 嘗試讓每個我方單位出刀 (有刀就砍)
    for c in list(cur.on_board):
        if gs.number_of_attacks[cur.name] <= 0:
            break
        if not c.numbness and c.health > 0:
            act(cur.name, "attack", c.board_x, c.board_y)
    r = act(cur.name, "end_turn")
    logger.info(f"TEST score_after_turn {gs.turn_number} = {gs.score}")
    if r and r.quit:
        print("game over:", r.message)
        break

logger.info(f"TEST done turn={gs.turn_number} score={gs.score}")
logger.close()
print("jsonl:", log_path.with_suffix(".jsonl"))
print("turn:", gs.turn_number, "score:", gs.score,
      "p1 board:", [(c.job_and_color, c.board_x, c.board_y, c.health) for c in p1.on_board],
      "p2 board:", [(c.job_and_color, c.board_x, c.board_y, c.health) for c in p2.on_board])
