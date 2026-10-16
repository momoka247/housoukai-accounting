# 放送会 会計LINE

LINE公式アカウントから、申請手順の確認・利用明細の確認登録・残高照会・支払予定の確認と完了操作を行うPythonアプリです。
ローカル実装済みです。LINE・Googleの認証情報とHTTPS公開先を設定するまでは、本番LINEへの返信・写真OCR・Gmail同期は動作しません。

## 会計ルール

- 三菱UFJ銀行＝団体口座、みずほ銀行＝公金口座。
- 開始時の両口座の実際の残高を2行で登録します。元のExcelの日付・残高・金額は流用していません。
- 差引残高＝開始時の合計残高＋外部からの収入−外部への支出。
- 公金口座と団体口座の間の移動は、本体を出納帳へ計上しません。口座別残高には記録します。
- 三菱UFJ銀行の**振込明細**にある「入金額」は、振込先への支払本体として支出にします。部費など本当の受取入金は手入力の「収入」で登録します。
- 外部への振込は、**本体＋手数料を選択した科目の1行の支出金額に合算**します。内部振替の手数料だけは「支．振込手数料」の1行にします。
- 「活動費申請」「後援会補助申請」の2列は空白です。
- 銀行ごとの最新登録残高と、出納帳の合計残高は別に管理します。表示する残高は明細日付きの記録残高です。
- 提供された科目一覧を使用します。「内容 切手代」など一意に分類できる説明は科目候補を提案します。銀行の利用明細だけでは購入品・耐用年数・援助金の種類を特定できないため、迷う場合は科目を空欄にして確認します。

## 必要な設定

Python 3.12以降。外部Pythonパッケージは不要です。

1. `.env.example` を `.env` にコピーします。
2. LINE公式アカウントのMessaging APIを有効にし、チャネルシークレットとチャネルアクセストークンを設定します。
3. LINE Developersで確認した会計担当者のuserIdを `LINE_ALLOWED_USER_IDS` に設定します。未設定時は起動を拒否します。
4. `LINE_NOTIFICATION_TARGET` に通知を受け取る担当者のuserIdを設定します。公式LINEを友だち追加してください。グループで使う場合は、そのgroupIdを指定し、担当者のuserIdも許可リストに入れます。グループメンバー全員が投稿を閲覧できる点に注意してください。
5. `TRANSFER_BRANCH` と `TRANSFER_ACCOUNT` に、指定された三菱UFJ銀行の支店名・団体口座番号を設定します。暗証番号は保存しません。
6. 写真を使う場合はGoogle Cloud Vision APIを有効にし、`GOOGLE_VISION_API_KEY` を設定します。画像はOCR時にGoogleへ送信します。画像自体はこのアプリのディスクへ保存しません。
7. Gmailを使う場合は下の接続手順を実行します。
8. `python server.py` で起動します。
9. HTTPS対応サーバーまたはリバースプロキシからポート8080へ接続し、LINEのWebhook URLを `https://取得したドメイン/webhook` に設定します。Webhook利用を有効にし、必要に応じて標準の自動応答を無効にしてください。

`GET /health` が稼働確認です。Webhookは署名を検証し、受信したイベントをSQLiteに保存してから処理します。1プロセス・1ワーカーで常時稼働させてください。停止中はリマインドできません。

### Gmailの接続

Google CloudでGmail APIを有効にし、OAuth同意画面に放送会のアカウントを追加します。OAuthクライアントは「デスクトップアプリ」で作成します。
このアプリはメールを送信・削除しません。必要なスコープは `https://www.googleapis.com/auth/gmail.readonly` です。

`.env` に `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` を入れ、`python setup_google.py` を実行します。表示されたGoogleのURLを自分のブラウザーで開き、**tbahousoukai@gmail.com** で許可してください。認証後、refresh tokenはローカルの `.env` に保存されます。トークンをチャットやGitHubへ貼らないでください。
OAuthアプリがテスト状態の場合は認証の有効期間・運用条件をGoogleの画面で確認し、長期運用に必要な公開状態や審査を整えてください。

15分ごとに直近60日の請求・支払・振込・入金関連メールを最大50件確認します。件名・差出人と読み取れた金額・期限をLINEに送り、会社名や不足情報を担当者が補って「登録」を押した後に通知対象にします。年のない期限、複数金額、添付PDFの内容は推測しません。初版は添付ファイルを読み取りません。同じGmailメッセージは再登録しません。別メールに同じ請求書がある場合は担当者が重複候補を破棄してください。

## LINEの使い方

「事前申請」「事後申請」「団体口座」「公金口座」を送ると指定の操作手順を案内します。「団体口座 残高」「公金口座 残高」で残高、「科目一覧」で科目を表示します。

### 最初に開始残高を登録

次の例の日付・残高を実際の開始日の値へ変更して送信し、「登録」を押します。

```text
開始残高 {"日付":"2027-04-01","団体口座":10000,"公金口座":20000}
```

登録後の開始残高の上書きはできません。年度の切り替えは別のDATA_DIRで開始します。上期・下期・年度末の締め行を自動で作る機能は初版にはありません。

### 利用明細の写真を登録

写真を送ると、読取候補と「登録」「破棄」ボタンを送ります。銀行名だけでは振込元と振込先を区別できないため、口座は担当者に確認します。
不足項目は、確認待ちが1件のとき、次のように1項目ずつ送れます。

```text
口座 団体口座
内部振替 いいえ
科目 支．消耗品費
手数料 110
残高 8890
日付 2027-04-02
```

「内容 切手代」「内容 図書代」などで科目候補を付けることもできます。備品費と消耗品費のように価格・耐用年数の確認が必要なものは、科目を担当者に確認します。

「内部振替 はい」は両口座の間の送金です。「方向 収入」「方向 支出」で方向を入力できます。
金額は振込本体を指定し、手数料は別欄へ入力します。**本体の欄に手数料込みの合計を入れると二重に引かれるため、本体金額を確認してください。** 不明な手数料は0扱いにせず、確認するまで登録を止めます。
三菱UFJ銀行の「入金額」表記の写真は、団体口座を指定すると方向が「支出」に変わります。実際の入金を写した写真の場合は候補を破棄し、下の手入力で「収入」として登録してください。

確認待ちが複数あるときは「確認待ち」でIDを確認し、次の形式で指定します。

```text
修正 確認ID {"科目":"支．備品費","金額":30000,"手数料":110}
```

読取後の値を確認して「登録」を押した時点で、SQLiteと会計ファイルを更新します。同じ写真の再送や同じ登録ボタンの連打で重複登録しません。ただし別の撮影画像の重複までは自動判定しません。
誤登録は「取消 取引ID」で確認ボタンを押して取り消し、正しい内容を別途入力します。監査履歴は残ります。

### 写真なしで登録

```text
取引 {"日付":"2027-04-02","口座":"団体口座","方向":"支出","金額":1000,"手数料":110,"残高":8890,"内部振替":false,"科目":"支．消耗品費"}
```

この例は出納帳の支出金額に1,110円を1行で記録し、合計残高は28,890円になります。

### 支払予定と完了

```text
支払登録 {"会社":"支払先会社","金額":1000,"期限":"2027-04-10"}
```

内容を確認して登録すると、期限の3日前・1日前・当日の09:00以降（日本時間）に公式LINEから通知します。
「未払い」では未完了の4件を期限順で表示します。振込後に通知の**「完了」**を押すと支払済みとなり、以降のリマインドを止めます。完了操作自体では出納帳を更新しません。二重計上を避けるため、実際の明細を登録してください。

## Excelとバックアップ

`templates/ledger.xlsx` はいただいた出納帳のレイアウトを元に、実取引を除いた新しいテンプレートです。
本番ファイルは `data/会計ファイル.xlsx` です。「会計ファイル」で再出力できます。LINEへのファイル添付は初版にはなく、サーバーのデータフォルダーから取得します。
Excelを開いたまま出力に失敗した場合はファイルを閉じて再出力してください。記帳の正本はSQLiteです。Excel側の直接編集は次回出力で置き換わります。
取引行は自動で増やし、差引残高には数式と計算済み値を入れます。G・H列は空白にします。
`data` は永続ディスクに保存してください。バックアップはアプリ停止中のdataフォルダー一式、またはSQLiteのbackup APIで取得してください。稼働中のDB本体だけのコピーではWALの更新を取りこぼす場合があります。

Dockerの場合の例：

```sh
docker build -t housoukai-accounting .
docker run --env-file .env -p 8080:8080 -v housoukai-data:/app/data housoukai-accounting
```

## テスト

```sh
python -m unittest discover -s tests -v
```

会計計算、内部振替、手数料合算、三菱UFJの入金額表記、確認操作の権限・重複、通知停止、署名検証、45件の取引を含むExcel拡張を検証します。
実際のLINE・Gmail・Cloud Visionとの通信は、認証設定後に実機確認が必要です。最初にテスト用のDATA_DIRで、ご自身のLINEへ案内・写真登録・支払通知・完了を一通り試してください。

## GitHubで公開する

公開先は [momoka247/housoukai-accounting](https://github.com/momoka247/housoukai-accounting) です。
初回登録のコマンドは次のとおりです。すでに取得済みの作業フォルダーでは `git init` と `git remote add` を繰り返す必要はありません。

```sh
git init
git add .gitignore .env.example accounting.py integrations.py bot.py excel_export.py server.py setup_google.py categories.json templates/ledger.xlsx tests README.md Dockerfile .dockerignore .github
git commit -m "Create broadcasting club accounting LINE app"
git branch -M main
git remote add origin https://github.com/momoka247/housoukai-accounting.git
git push -u origin main
git tag v0.1.0
git push origin v0.1.0
```

`v*` タグをpushすると、GitHub Actionsがテスト後にGitHub Releaseを作成し、アプリのZIPを添付します。実際のリポジトリ名が異なる場合はURLを変更してください。GitHub Releasesへの公開と、LINE用サーバーへの配置・稼働は別の操作です。
`.env`、利用者ID、実口座情報、取引記録、メール、DBは公開対象へ含めません。

## API仕様の参照

- [LINE Messaging API](https://developers.line.biz/en/reference/messaging-api/)
- [Webhook署名検証](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [Cloud Vision OCR](https://docs.cloud.google.com/vision/docs/ocr)
- [Gmail messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Google OAuth for installed applications](https://developers.google.com/identity/protocols/oauth2/native-app)
