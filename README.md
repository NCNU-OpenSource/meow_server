    # MEOW Server
    111213076 郭哲瑋 111213078 陳逸憲	111213019 李玨叡	111213052 鄒啟翔
    ## Concept Development
    我們在學 Linux、網路的時候，最常遇到一個痛點： 看懂教材不等於真的會修。

    很多時候老師或助教講完指令後我們當下覺得懂了，但一到實作： 不知道從哪裡開始查 查了半天、修了又壞、甚至把整台機器弄到回不來 或者是大家做的環境都不一樣，很難比對問題

    更麻煩的是，真實世界的問題幾乎都不是「一個指令就好」 它需要 反覆試、反覆回復、反覆驗證，但課堂上沒有那麼多時間，也沒有那麼多乾淨的環境可以讓每個人一直重做。

    所以我們做了一個「可回復的故障訓練平台」：老師上傳教材→系統產題→每個學生有自己的 VM→每題產生故障→學生修復→系統驗證→rollback之後再練下一題。


    ## Implementation Resources
    OS：Ubuntu / Linux

    Runtime：Docker（必須）

    後端：Python + Flask（提供 API 與 Web UI）

    前端：純 HTML/CSS/JS（輪詢 API、顯示題目與提示）

    題目環境：Docker image meow-lab-image（容器名 trainee）

    ## Existing Library/Software
    Python 3

    Flask（API：/api/start, /api/status, /api/hint）

    Docker CLI（由後端呼叫 docker run/exec/rm）

    SMTP（Gmail SMTP SSL）用於 Email 通知/提醒

    ## Implementation Process
    本專案採用「每次出題都重置環境」的方式來確保可重複性：
    當使用者開始挑戰或背景 daemon 自動出題時，系統會先刪除舊的 trainee 容器，再重新 docker run -d --name trainee meow-lab-image，並初始化 /var/www/html/index.html 為正常狀態。
    題目以 template 形式維護：每個題目包含 id/desc/explain/chaos_cmd/check_cmd/hints，出題時執行 chaos_cmd 造成故障；狀態檢查時執行 check_cmd，若輸出包含 OK 即判定完成。

    後端同時支援：
    - 手動出題：前端按「開始挑戰」呼叫 /api/start
    - 自動出題：背景 thread chaos_daemon() 在無 active 任務時，等待 30–60 秒後自動出題
    - Email 通知：出題即寄信；未完成則依 remind_interval 寄提醒（目前 demo 設 30 秒）

    在完成系統環境與套件安裝後，實際操作流程如下：

    進入專案目錄
    ```bash
    cd 你clone的檔案
    ```

    建立 Python 虛擬環境並啟用

    ```bash
    python3 -m venv venv
    source venv/bin/activate
    ```

    啟動後端 Flask Server

    ```bash
    python app.py
    ```

    建立 Chaos Lab Docker Image

    ```bash
    docker build -t meow-lab-image .
    ```

    啟動 Trainee 容器

    系統在出題時會自動執行以下邏輯：

    ```bash
    docker rm -f trainee 2>/dev/null
    docker run -d --name trainee meow-lab-image
    ```

    ## Knowledge from Lecture
    Linux系統基本指令

    mail server

    Docker

    Nginx

    ## Installation
    主要使用 Python 與 Flask 作為後端服務，因此需先安裝 Python 與 pip。

    ```bash
    sudo apt update
    sudo apt install -y python3 python3-pip python3-venv
    pip install --upgrade pip
    pip install flask
    ```

    ```bash
    sudo apt install -y docker.io
    ```

    ## Usage
    1. 打開首頁後，按 **開始挑戰（重置練習機）**  
    2. 左側會顯示簡短描述，右側會顯示題目說明與提示對話框
    3. 若卡住，可按 **給我下一步提示** 逐步拿提示（提示步驟由 `/api/hint` 依 step 取回） 
    4. 前端每秒輪詢 `/api/status` 顯示：進行中 / 已完成 / 超時

    ### 進入練習環境（容器）

    每次出題後，用這個指令進入容器修復：

    ```bash
    sudo docker exec -it trainee bash
    ```

    ## Job Assignment
    - 111213076 郭哲瑋：簡報製作、主題構想、撰寫Readme、資料整理
    - 111213078 陳逸憲：主題構想、資料整理
    - 111213019 李玨叡：主題構想、建立初始架構
    - 111213052 鄒啟翔：github編寫、腳本設計、
    ## References
    https://github.com/NCNU-OpenSource/student-labs 
    https://github.com/labex-labs/linux-practice-challenges
