# 月額0円を目指す構成の設定手順

この版は、Google Apps Script・Google Drive・Cloudflare Workers Free・LINE公式アカウントの無料プランを使います。
Render、Cloud Vision API、有料Workers、独自ドメインは契約しません。課金情報の登録はこの構成には不要です。
サービス各社の無料枠とGoogle Driveの空き容量の範囲で動作します。上限時は処理・通知が止まるため、重要な期限は「未払い」でも確認してください。

## 構成

- Cloudflare Worker：LINEの署名を確認してApps Scriptへ転送。DB・AI・R2などの有料機能は使いません。
- Apps Script：通常のLINE返信、Gmailの読み取り、5分ごとの定期処理。
- Google Drive：内部記録・出納帳原本・Excelファイル。写真のOCRは画像を一時的なGoogle Docsへ変換して行い、処理後はその一時ファイルをゴミ箱へ移動します。
- LINE：通常の返信はReply API。支払リマインド・Gmail候補・写真結果だけPush API。

設定には放送会のGoogleアカウントを使います。作成したDriveファイルは一般公開しません。

## 閲覧と編集の権限

「事後申請」「事前申請」「団体口座」「公金口座」「団体口座 残高」「公金口座 残高」「使い方」は全員が利用できます。グループ内でも公開コマンドは利用できます。
金額・日付・開始残高の登録、修正、取消、写真の登録、支払完了操作、確認待ち・未払い・科目一覧・Excelの取得などは、`LINE_ALLOWED_USER_IDS` に指定された会計担当者だけが利用できます。担当者の管理操作は個別トーク、または `LINE_NOTIFICATION_TARGET` に設定した会計用グループで行います。
担当者を追加するときはユーザーIDをカンマ区切りで追記します。一般の閲覧者はユーザーIDの登録不要です。公開する残高は、銀行への直接照会ではなく登録済み明細の残高です。
Cloudflareを挟むのは、Apps ScriptのdoPostがLINE署名ヘッダーを直接検証できないためです。WorkerでLINEの原文署名を検証し、WorkerとApps Script間も共通秘密鍵によるHMACで認証します。Apps ScriptのURLだけをLINEのWebhookに設定しないでください。

## 1. Apps Scriptのプロジェクトを作成

1. **tbahousoukai@gmail.com** で [Apps Script](https://script.google.com/home/start) を開き、「新しいプロジェクト」を選びます。
2. プロジェクト名を「放送会会計」にします。
3. 初期の `コード.gs` を、このフォルダーの `Code.gs` の内容で置き換えます。
4. スクリプトファイルを追加し、名前を `Core` にして `Core.gs` の内容を貼ります。
5. 「プロジェクトの設定」で「appsscript.json マニフェスト ファイルをエディタで表示する」を有効にします。
6. `appsscript.json` を、このフォルダーの同名ファイルの内容に置き換えます。タイムゾーンはAsia/Tokyoです。
7. 「サービス」に **Drive API v3** と **Gmail API v1** が表示されることを確認します。なければ「＋」から追加します。

新しいデフォルトのApps Scriptプロジェクトでは、別のGoogle Cloud OAuthクライアントやrefresh tokenを手動発行する必要はありません。Cloud Vision APIを有効にする必要もありません。

## 2. Excelテンプレートと設定値を登録

1. GitHubの `templates/ledger.xlsx` をダウンロードし、放送会のGoogle Driveへアップロードします。元の取引が入ったファイルではなく、この空のテンプレートを使います。
2. Driveのファイルを開いたURLからファイルIDを確認します。`/file/d/ファイルID/view` の中央部分です。共有設定は制限付きのままにします。
3. Apps Scriptの「プロジェクトの設定」→「スクリプト プロパティ」に次を登録します。

| 名前 | 値 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 既存の `.env` に入力したアクセストークン |
| `LINE_ALLOWED_USER_IDS` | 同じ `.env` の会計担当者のuserId |
| `LINE_NOTIFICATION_TARGET` | 同じ `.env` の通知先userId |
| `TRANSFER_BRANCH` | 同じ `.env` の支店名 |
| `TRANSFER_ACCOUNT` | 同じ `.env` の口座番号 |
| `GMAIL_ACCOUNT` | `tbahousoukai@gmail.com` |
| `EXCEL_TEMPLATE_FILE_ID` | アップロードした空のテンプレートのID |
| `GATEWAY_SHARED_SECRET` | 新しく用意する32文字以上のランダムな共通秘密鍵 |
| `LINE_PUSH_BUDGET` | `180` |

共通秘密鍵はパスワード管理アプリなどで英数字・記号を含めて生成し、後でCloudflareにも同じ値を登録します。チャットやGitHubには貼らないでください。
LINEのチャネルシークレットはApps Scriptには登録せず、Cloudflare側だけに保存します。

## 3. 初期設定とGoogleの許可

1. Apps Scriptエディターで実行する関数に `setup` を選択して「実行」を押します。
2. Googleへのアクセス許可画面が出たら、放送会アカウントで内容を確認して許可します。このプログラムでは、Gmailを読み取り、Drive上に会計用ファイルとOCR用の一時Docsを作成します。メールの送信・削除はしません。許可画面にはDrive・Docs・Sheetsなどの権限も表示されます。
3. エディターの実行ログに「設定完了」と表示されることを確認します。
4. Driveに「放送会会計（非公開）」というフォルダーと内部記録・原本が作られます。5分ごとの `tick` トリガーも設定されます。

同じスクリプトでsetupを再実行しても、既存のDB・原本・トリガーは作り直しません。本番ファイルはまだ未入力です。LINEから実際の開始残高を登録してから使います。

## 4. Apps ScriptをWebアプリとして配置

1. 「デプロイ」→「新しいデプロイ」を選びます。
2. 種類を「ウェブアプリ」にします。
3. 実行するユーザーは「自分」、アクセスできるユーザーは「全員」にします。
4. 配置して、末尾が `/exec` のWebアプリURLを控えます。

「全員」はLINEの中継サーバーからアクセスするために必要です。URLへ直接リクエストしても、共通秘密鍵による有効な署名がない操作は拒否します。
組織の管理ポリシーで「全員」が選べない場合は、その状態を伝えてください。設定を迂回せず、利用可能な配置方法を確認します。

## 5. Cloudflare Workerを無料プランで作成

1. [Cloudflare](https://dash.cloudflare.com/sign-up) に登録します。
2. 「Workers & Pages」からWorkerを作成します。**Workers Free** を選びます。ドメイン追加・有料プラン・R2・D1の契約は不要です。
3. Worker名を `housoukai-line-gateway` などにします。
4. コードを `gateway/worker.mjs` の内容に置き換えて配置します。
5. Workerの「Settings」→「Variables and Secrets」で、次を **Secret** として追加します。

| 名前 | 値 |
|---|---|
| `LINE_CHANNEL_SECRET` | 既存 `.env` のチャネルシークレット |
| `GATEWAY_SHARED_SECRET` | Apps Scriptと同じ共通秘密鍵 |
| `APPS_SCRIPT_URL` | Apps Scriptの `/exec` URL |

6. 設定を配置に反映し、Workerの `https://…workers.dev` URLを確認します。

コードから配置する場合は `gateway/wrangler.toml` を使えます。設定ファイルに秘密の値を書き込まないでください。初回は上の画面操作だけで設定できます。

## 6. LINEのWebhookを設定

LINE DevelopersのMessaging API設定で、Webhook URLを次にします。

```text
https://作成したWorkerのURL/webhook
```

「検証」を実行し、「Webhookの利用」と「Webhookの再送」を有効にします。公式アカウントの標準自動応答と二重になる場合は標準側をオフにします。
接続検証は署名検証までの確認です。Apps Scriptまでつながっていることは、次の実際のメッセージでも確認します。

## 7. 本番利用前の確認

LINEで「使い方」と送ると、送信する言葉と表示される手順・機能の短い説明書が返ります。「ヘルプ」では入力方法の詳しい例を確認できます。

1. LINEで「事前申請」を送り、手順が返ることを確認します。
2. 「公金口座」を送り、設定した振込先が表示されることを確認します。
3. 実際の開始日と両口座の残高を「開始残高」コマンドで入力し、確認ボタンで登録します。
4. 「団体口座 残高」「公金口座 残高」が合っているか確認します。
5. 利用明細の写真を1枚送ります。無料版は**2MB以下**の画像に対応します。数分後の結果を確認・修正して登録します。読み取り精度や処理時間は実際の明細で確認が必要です。
6. 「会計ファイル」で、放送会のGoogleアカウントにログインしてExcelを開きます。更新まで最大数分程度かかります。Driveから `.xlsx` をダウンロードできます。
7. Gmailの請求候補が確認待ちに入るか確認します。最初は直近60日・最大50件から、15分ごとに未確認の最大5件を取り込みます。添付PDFは読み取りません。
8. テスト用の支払予定で「未払い」と「完了」を試します。完了後に候補から消えることを確認します。

支払通知は3日前・1日前・当日の日本時間09:00以降に、5分間隔の処理で判断します。Google側の実行タイミングにより遅れる場合があります。振込後は「完了」を押し、会計への記録には実際の利用明細を別途登録します。

## 無料枠と止まる条件

- 通常の返信はLINEのReply APIで、無料プランの配信通数に含まれません。
- 定期通知・Gmail候補・写真結果はPush APIです。このアプリではLINE側の使用数を確認し、**月180通**または設定値の小さい方で配信を止めます。LINE無料プランの200通に余裕を残すためです。他の配信で使用済みの通数も確認対象になります。
- 上限後も「確認待ち」「未払い」「利用状況」へ返信できます。写真の処理結果は確認待ちに残ります。古い未送信の支払リマインドは後日送信しません。
- Google Apps Script・Drive・Cloudflareの無料枠を超えると処理が失敗する場合があります。この構成が自動で有料プランを契約することはありません。
- Driveの空き容量が不足した場合は保存・OCRが止まります。ゴミ箱の一時OCRファイルもストレージを使用するため、必要に応じてDriveで整理します。
- スクリプトエディターの「実行数」で失敗を確認できます。エラーが続いた場合は処理名を伝えてください。認証情報やメール本文を貼る必要はありません。

## 更新と引継ぎ

コードを変更したらApps Scriptの新しいバージョンを配置し、Workerのコード更新も反映します。
担当者の交代時は許可ユーザーID・通知先を変更します。Google側は放送会アカウントで所有し続けます。定期処理はトリガーを作成したアカウントの権限で動きます。
データの正本は「内部記録」です。そこを直接編集しないでください。Excelへの直接編集も次回出力で置き換わります。バックアップはDriveの会計フォルダーを必要に応じてコピーして保管します。
Google Sheets経由のExcel変換で、印刷設定など一部の見た目が元のExcelと変わる可能性があります。実際の変換後ファイルを初回接続時に確認します。

## 検証状況

ローカルで会計規則と署名中継を検証しています。Googleへの初回許可、Drive OCR、Excel変換、LINEとの実通信は、上記の設定後に実機確認が必要です。まだ本番接続済みではありません。

## 仕様・料金の参照

- [LINEの無料プラン・メッセージの数え方](https://www.lycbiz.com/jp/service/line-official-account/plan/)
- [Apps Scriptの無料アカウント向け割当](https://developers.google.com/apps-script/guides/services/quotas)
- [Apps Scriptの定期トリガー](https://developers.google.com/apps-script/guides/triggers/installable)
- [Driveの画像→Google Docs変換とOCR](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Cloudflare Workers Freeの上限](https://developers.cloudflare.com/workers/platform/limits/)
