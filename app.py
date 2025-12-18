from flask import Flask, request, jsonify, send_from_directory
import time
import random
import threading
import smtplib
from email.message import EmailMessage

from chaos_engine import (
    init_container,
    pick_random_template,
    check_template_done,
    run,
    get_template_by_id,
)

app = Flask(__name__, static_folder="static")
SESSION_LOCK = threading.Lock()
# ===== 簡單記憶體 session，只支援單一使用者 demo =====
CURRENT_SESSION = {
    "active": False,
    "start_time": None,
    "timeout": 600,          # 給前端顯示用的倒數（秒）
    "template_id": None,
    "last_remind_at": None,  # 上一次寄信時間（秒）
    "remind_interval": 3600  # 每隔多久提醒一次（預設 1 小時，可改 60 做 demo）
}

# ===== 寄信設定 =====
# TODO：這裡換成你的 Gmail / 應用程式密碼 / 收信人
SMTP_USER = "example@gmail.com"        # 你的 Gmail 帳號
SMTP_PASS = "application password"           # Gmail 產生的「應用程式密碼」
USER_EMAIL ="example@gmail.com"       # 收信人（可以跟上面同一個）

def send_email(subject: str, body: str):
    """共用的寄信小工具"""
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_USER
    msg["To"] = USER_EMAIL
    msg.set_content(body)

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(SMTP_USER, SMTP_PASS)
            smtp.send_message(msg)
        print(f"[EMAIL] Sent: {subject}")
    except Exception as e:
        print("[EMAIL ERROR]", e)


def send_new_incident_email(tpl):
    """新的故障事件發生時寄出第一封通知信"""
    start_ts = CURRENT_SESSION.get("start_time") or time.time()
    start_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(start_ts))

    body = f"""喵～新的 Linux 故障發生了！

題目 ID：{tpl["id"]}
描述：{tpl["desc"]}
發生時間：{start_str}

請登入練習機進行除錯：
    sudo docker exec -it trainee bash

提示：你也可以打開 Web 介面查看題目說明與提示。
"""

    send_email("喵 Server：新的故障挑戰來了", body)


def send_reminder_email():
    """題目還沒修好時，定期寄出提醒信"""
    if not CURRENT_SESSION["active"]:
        return

    tpl = get_template_by_id(CURRENT_SESSION.get("template_id"))
    elapsed = int(time.time() - (CURRENT_SESSION.get("start_time") or time.time()))

    desc = tpl["desc"] if tpl else "(找不到題目描述)"
    tid = tpl["id"] if tpl else "(unknown)"

    body = f"""喵～你還沒修好這一題喔 QQ

題目 ID：{tid}
描述：{desc}
已經過時間：{elapsed} 秒

快回來用這個指令登入查看狀況：
    sudo docker exec -it trainee bash

    sudo docker exec -it trainee bash

（這封信是定期提醒，你也可以在簡報裡說未來可以調整提醒頻率）
"""
    send_email("喵 Server 提醒你：故障還沒修好！", body)


# ===== 出題邏輯 =====
def start_game_internal():
    """實際的出題邏輯：被 /api/start 和背景 daemon 共用"""
    with SESSION_LOCK:
        ok, err = init_container()
        if not ok:
            return {"ok": False, "error": "failed to start container", "stderr": err}, 500

        # 從題庫抽一題（你現在是依序出題）
        tpl = pick_random_template()
        if tpl is None:
            return {"ok": False, "error": "no_template_defined"}, 500

        # 執行這一題的破壞指令
        run(tpl["chaos_cmd"])

        now = time.time()
        CURRENT_SESSION["active"] = True
        CURRENT_SESSION["start_time"] = now
        CURRENT_SESSION["timeout"] = 600              # 給前端顯示倒數用
        CURRENT_SESSION["remind_interval"] = 30       # demo 用 30 秒，之後可改 3600
        CURRENT_SESSION["last_remind_at"] = now       # 剛出題當作已提醒一次
        CURRENT_SESSION["template_id"] = tpl["id"]

    # 注意：寄信不一定要在鎖裡做，放在外面比較不會卡住其他操作
    send_new_incident_email(tpl)

    resp = {
        "ok": True,
        "template_id": tpl["id"],
        "desc": tpl["desc"],
        "explain": tpl.get("explain", ""),
        "hints_count": len(tpl.get("hints", [])),
        "message": f"喵！{tpl['desc']}",
        "hint": tpl.get("hint", ""),
        "login_hint": "在終端機中輸入：sudo docker exec -it trainee bash",
        "timeout_seconds": CURRENT_SESSION["timeout"]
    }
    return resp, 200



@app.route("/api/start", methods=["POST"])
def start_game():
    resp, status = start_game_internal()
    return jsonify(resp), status


@app.route("/api/status", methods=["GET"])
def status():
    with SESSION_LOCK:
        if not CURRENT_SESSION["active"]:
            return jsonify({"active": False, "status": "idle"})

        now = time.time()
        elapsed = int(now - CURRENT_SESSION["start_time"])
        remaining = CURRENT_SESSION["timeout"] - elapsed

        # 超時邏輯
        if remaining <= 0:
            CURRENT_SESSION["active"] = False
            CURRENT_SESSION["template_id"] = None
            CURRENT_SESSION["last_remind_at"] = None
            return jsonify({
                "active": False,
                "status": "timeout",
                "elapsed": elapsed,
                "message": "超過時間了，貓咪暴走！"
            })

        tpl = get_template_by_id(CURRENT_SESSION.get("template_id"))

    # 👆 注意：這裡我刻意在鎖外面做 check_template_done，
    #   減少鎖持有時間（因為它會跑 docker 指令，比較慢）

    if not tpl:
        return jsonify({
            "active": False,
            "status": "error",
            "message": "找不到題目模板"
        }), 500

    # 檢查是否已修好
    if check_template_done(tpl):
        with SESSION_LOCK:
            CURRENT_SESSION["active"] = False
            CURRENT_SESSION["template_id"] = None
            CURRENT_SESSION["last_remind_at"] = None
        return jsonify({
            "active": False,
            "status": "success",
            "elapsed": elapsed,
            "message": f"任務完成！你花了 {elapsed} 秒"
        })

    # 還沒修好
    return jsonify({
        "active": True,
        "status": "pending",
        "elapsed": elapsed,
        "remaining": remaining,
        "message": "貓咪在旁邊看你 debug 中…"
    })


@app.route("/api/hint", methods=["POST"])
def get_hint():
    with SESSION_LOCK:
        if not CURRENT_SESSION["active"]:
            return jsonify({"ok": False, "error": "no_active_session"}), 400

        tpl = get_template_by_id(CURRENT_SESSION.get("template_id"))

    if not tpl:
        return jsonify({"ok": False, "error": "no_template"}), 400

    data = request.get_json(silent=True) or {}
    step = int(data.get("step", 0))

    hints = tpl.get("hints", [])
    if step < 0 or step >= len(hints):
        return jsonify({"ok": False, "done": True})

    return jsonify({
        "ok": True,
        "step": step,
        "text": hints[step],
        "has_more": step < len(hints) - 1
    })



@app.route("/")
def index_page():
    # 回傳 static/index.html，前端喵喵頁面
    return send_from_directory(app.static_folder, "index.html")


# ====== 背景「不定時丟題目 + 定期寄信提醒」Daemon ======
def chaos_daemon():
    """背景執行緒：不定時自動出題 + 定期寄信提醒"""
    while True:
        now = time.time()

        # 1. 沒有 active 題目 → 隨機等一段時間後「嘗試」自動出題
        with SESSION_LOCK:
            active = CURRENT_SESSION["active"]

        if not active:
            wait = random.randint(30, 60)  # demo：30~60 秒；正式可改長
            print(f"[DAEMON] no active session, sleep {wait} sec")
            time.sleep(wait)

            # 醒來再檢查一次，避免這段時間使用者自己按了「開始挑戰」
            with SESSION_LOCK:
                if CURRENT_SESSION["active"]:
                    # 使用者自己已經出題了，daemon 就不要搶
                    continue

            print("[DAEMON] auto starting new chaos challenge")
            with app.app_context():
                # 這裡不用鎖，因為 start_game_internal 裡面已經有 SESSION_LOCK
                start_game_internal()
            continue

        # 2. 有 active 題目 → 判斷是否需要寄「定期提醒」
        with SESSION_LOCK:
            last = CURRENT_SESSION.get("last_remind_at")
            interval = CURRENT_SESSION.get("remind_interval", 3600)

        if last is None:
            with SESSION_LOCK:
                CURRENT_SESSION["last_remind_at"] = now
        else:
            if now - last >= interval:
                print("[DAEMON] sending reminder email")
                send_reminder_email()
                with SESSION_LOCK:
                    CURRENT_SESSION["last_remind_at"] = now

        time.sleep(10)


if __name__ == "__main__":
    # 啟動背景混沌 daemon
    t = threading.Thread(target=chaos_daemon, daemon=True)
    t.start()

    # 跑 Flask 伺服器
    app.run(host="0.0.0.0", port=5000)

