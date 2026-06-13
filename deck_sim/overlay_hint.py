# -*- coding: utf-8 -*-
# =====================================================================
# 午後激盪・實戰助手 浮動提示窗 (overlay)
#
# 置頂半透明小窗,疊在遊戲旁即時顯示:
#   本步最優解 + 完整回合計畫 + 迷你棋盤 (目標格高亮)
# 資料來源: advisor_bridge.js 寫出的 advisor_state.json (內含搜索結果)
#
# 用法:  python overlay_hint.py            (一般啟動)
#        python overlay_hint.py --selftest (無視窗自檢)
# 操作:  按住任意處拖曳移動 | 雙擊標題列摺疊/展開 | ✕ 關閉
# =====================================================================
import json
import os
import sys
import tkinter as tk

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, "advisor_state.json")
POLL_MS = 600

BG = "#14161c"
PANEL = "#1d2129"
ACCENT = "#ffc54d"
DIM = "#9aa3b5"
TEXT = "#e6e9f0"
P1 = "#4f8cff"
P2 = "#ff6363"
NEUTRAL = "#888888"
WIN_COL = "#7dde8b"
LOSE_COL = "#ff8d8d"

FONT = ("Microsoft JhengHei", 10)
FONT_BIG = ("Microsoft JhengHei", 13, "bold")
FONT_SMALL = ("Microsoft JhengHei", 9)

JOB_ZH = {"ADC": "射", "AP": "法", "TANK": "坦", "HF": "重", "LF": "輕",
          "ASS": "刺", "APT": "聖", "SP": "寶", "CUBE": "箱", "LUCKYBLOCK": "運"}

SUFFIXES = ["DKG", "W", "R", "B", "P", "O", "G"]
SPECIALS = {"CUBE", "LUCKYBLOCK", "MOVEO", "MOVE", "HEAL", "CUBES"}


def job_of(name: str) -> str:
    if name in SPECIALS:
        return name
    for s in SUFFIXES:
        if name.endswith(s):
            return name[: -len(s)]
    return name


class Overlay:
    def __init__(self, root: tk.Tk, hidden: bool = False):
        self.root = root
        self.collapsed = False
        self.last_updated = 0

        root.overrideredirect(True)          # 無邊框
        root.attributes("-topmost", True)    # 永遠置頂
        root.attributes("-alpha", 0.93)
        root.configure(bg=BG)
        sw = root.winfo_screenwidth()
        root.geometry(f"+{sw - 360}+60")     # 預設貼右上
        if hidden:
            root.withdraw()

        # ---- 標題列 (拖曳把手) ----
        self.title_bar = tk.Frame(root, bg=PANEL)
        self.title_bar.pack(fill="x")
        self.title_lbl = tk.Label(self.title_bar, text="⚡ 實戰助手", bg=PANEL, fg=ACCENT, font=FONT)
        self.title_lbl.pack(side="left", padx=8, pady=3)
        close = tk.Label(self.title_bar, text=" ✕ ", bg=PANEL, fg=DIM, font=FONT, cursor="hand2")
        close.pack(side="right", padx=4)
        close.bind("<Button-1>", lambda e: root.destroy())
        fold = tk.Label(self.title_bar, text=" — ", bg=PANEL, fg=DIM, font=FONT, cursor="hand2")
        fold.pack(side="right")
        fold.bind("<Button-1>", lambda e: self.toggle())
        self.title_bar.bind("<Double-Button-1>", lambda e: self.toggle())

        # 拖曳
        for w in (self.title_bar, self.title_lbl):
            w.bind("<Button-1>", self._drag_start)
            w.bind("<B1-Motion>", self._drag_move)

        # ---- 內容 ----
        self.body = tk.Frame(root, bg=BG)
        self.body.pack(fill="both", expand=True, padx=8, pady=6)

        self.status_lbl = tk.Label(self.body, text="等待橋接器…", bg=BG, fg=DIM,
                                   font=FONT_SMALL, anchor="w", justify="left")
        self.status_lbl.pack(fill="x")

        self.warn_lbl = tk.Label(self.body, text="", bg=BG, fg=LOSE_COL,
                                 font=FONT_SMALL, anchor="w", justify="left", wraplength=320)
        self.warn_lbl.pack(fill="x")

        self.first_lbl = tk.Label(self.body, text="—", bg=BG, fg=ACCENT,
                                  font=FONT_BIG, anchor="w", justify="left", wraplength=320)
        self.first_lbl.pack(fill="x", pady=(4, 4))

        mid = tk.Frame(self.body, bg=BG)
        mid.pack(fill="x")
        self.cell = 34
        self.canvas = tk.Canvas(mid, width=self.cell * 4 + 2, height=self.cell * 4 + 2,
                                bg=PANEL, highlightthickness=0)
        self.canvas.pack(side="left", padx=(0, 8))
        self.plan_lbl = tk.Label(mid, text="", bg=BG, fg=TEXT, font=FONT_SMALL,
                                 anchor="nw", justify="left", wraplength=176)
        self.plan_lbl.pack(side="left", fill="both", expand=True)

        self.meta_lbl = tk.Label(self.body, text="", bg=BG, fg="#5d6678",
                                 font=FONT_SMALL, anchor="w", justify="left")
        self.meta_lbl.pack(fill="x", pady=(4, 0))

        self.refresh()

    # ---- 拖曳 ----
    def _drag_start(self, e):
        self._dx, self._dy = e.x_root - self.root.winfo_x(), e.y_root - self.root.winfo_y()

    def _drag_move(self, e):
        self.root.geometry(f"+{e.x_root - self._dx}+{e.y_root - self._dy}")

    def toggle(self):
        self.collapsed = not self.collapsed
        if self.collapsed:
            self.body.pack_forget()
        else:
            self.body.pack(fill="both", expand=True, padx=8, pady=6)

    # ---- 渲染 ----
    def draw_board(self, data, highlight):
        c = self.canvas
        c.delete("all")
        s = self.cell
        hl = {(p[0], p[1]) for p in (highlight or [])}
        for y in range(4):
            for x in range(4):
                fill = "#3a3420" if (x, y) in hl else PANEL
                c.create_rectangle(x * s + 1, y * s + 1, x * s + s, y * s + s,
                                   fill=fill, outline="#323a4a")
        if (dump := data.get("stateDump")):
            units = (dump["players"]["player1"]["onBoard"]
                     + dump["players"]["player2"]["onBoard"]
                     + dump.get("neutral", []))
            for u in units:
                if u.get("hp", 0) <= 0:
                    continue
                x, y = u["x"], u["y"]
                col = P1 if u["owner"] == "player1" else (P2 if u["owner"] == "player2" else NEUTRAL)
                c.create_rectangle(x * s + 3, y * s + 3, x * s + s - 2, y * s + s - 2,
                                   outline=col, width=2)
                tag = JOB_ZH.get(job_of(u["name"]), "?")
                fg = DIM if u.get("numbness") else TEXT
                c.create_text(x * s + s // 2, y * s + s // 2 - 4, text=tag, fill=fg, font=FONT_SMALL)
                c.create_text(x * s + s // 2, y * s + s // 2 + 9, text=str(u["hp"]), fill=fg,
                              font=("Microsoft JhengHei", 8))
        for (hx, hy) in hl:
            c.create_rectangle(hx * s + 1, hy * s + 1, hx * s + s, hy * s + s,
                               outline=ACCENT, width=2)

    def refresh(self):
        try:
            with open(STATE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            self.status_lbl.config(text="等待橋接器… (advisor_state.json 不可讀)")
            self.root.after(POLL_MS, self.refresh)
            return

        if data.get("status") == "waiting":
            self.status_lbl.config(text="橋接器運作中,等待對局開始…")
            self.root.after(POLL_MS, self.refresh)
            return
        if data.get("status") == "error":
            self.status_lbl.config(text="橋接器: " + str(data.get("error", ""))[:60])
            self.root.after(POLL_MS, self.refresh)
            return

        if data.get("updatedAt") == self.last_updated:
            self.root.after(POLL_MS, self.refresh)
            return
        self.last_updated = data.get("updatedAt", 0)

        meta = data.get("meta", {})
        turn = meta.get("turnNumber", 0) // 2 + 1
        score = meta.get("score", 0)
        lead = "持平" if score == 0 else (f"P1 領先 {-score}" if score < 0 else f"P2 領先 {score}")
        self.status_lbl.config(text=f"第 {turn} 輪・{lead}・動作 {meta.get('actionCount', '?')}")

        hint = data.get("hint") or {}
        mode = hint.get("mode")
        highlight = hint.get("cells") or []

        if mode == "rec":
            self.first_lbl.config(text="→ " + hint.get("first", "—"), fg=ACCENT)
            plan = hint.get("plan") or []
            self.plan_lbl.config(text="\n".join(f"{i+1}. {p}" for i, p in enumerate(plan[:6])))
            if hint.get("winFound"):
                self.warn_lbl.config(text="🏆 找到致勝序列!照計畫打完即獲勝", fg=WIN_COL)
            elif hint.get("loseUnavoidable"):
                self.warn_lbl.config(text="⚠ 對手下結算可獲勝,以下為最大抵抗", fg=LOSE_COL)
            else:
                self.warn_lbl.config(text="")
            self.meta_lbl.config(
                text=f"評估 {hint.get('evalScore','')}・搜索 {hint.get('elapsedMs','?')}ms・{hint.get('forSeat','')}")
        elif mode == "waiting":
            self.first_lbl.config(text=hint.get("text", "等待對手行動…"), fg=DIM)
            self.plan_lbl.config(text="")
            self.warn_lbl.config(text="")
            self.meta_lbl.config(text="")
        elif mode == "over":
            self.first_lbl.config(text=hint.get("text", "對局結束"), fg=DIM)
            self.plan_lbl.config(text="")
            self.warn_lbl.config(text="")
        elif mode == "error":
            self.first_lbl.config(text=hint.get("text", "搜索失敗"), fg=LOSE_COL)
        else:
            self.first_lbl.config(text="(橋接器版本過舊,無 hint 欄位)", fg=DIM)

        self.draw_board(data, highlight)
        self.root.after(POLL_MS, self.refresh)


def main():
    selftest = "--selftest" in sys.argv
    root = tk.Tk()
    root.title("實戰助手")
    overlay = Overlay(root, hidden=selftest)
    if selftest:
        def check():
            print("SELFTEST OK | status:", overlay.status_lbl.cget("text"),
                  "| first:", overlay.first_lbl.cget("text"))
            root.destroy()
        root.after(900, check)
    root.mainloop()


if __name__ == "__main__":
    main()
