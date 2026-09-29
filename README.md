# ai-ivr-jev

Twilio ConversationRelay × TypeSafe AI (Jev) × OpenAI で作る、水まわり修理業者向けの音声自動応答（IVR）サーバーです。

- 音声認識・音声合成・割り込みは **Twilio ConversationRelay** が担当（サーバーは WebSocket の JSON だけを扱う）
- 意図・機器・症状・緊急度・「今の発話は質問への答えか」などの **判定は Jev**（1 ターン 1 リクエストで並列判定、約 250ms）
- 切り分け・状況確認・日時や名前の聞き取り・復唱・緊急案内は **定型文で即返信**（LLM を通らない）
- 対処方法の一言や「止水栓はどこ？」のような質問だけ **OpenAI (gpt-4o-mini)** が文章を生成。その間も Jev の判定が返った時点で「少々お調べします」「ありがとうございます」を先に話す

```
お客様: 給湯器が故障してて、お湯が出ないんです
AI    : 給湯器の故障ですね。お湯はまったく出ませんか、それとも途中で止まりますか。
お客様: 全然出ないです
AI    : お風呂のリモコンにエラー番号は出ていますか。出ていれば番号を教えてください。
お客様: 111 が出てます
AI    : ありがとうございます。                                    ← Jev + 定型文（即時）
        ガスの元栓が開いているか確認してください。リモコンの運転を   ← OpenAI（約 1 秒後）
        一度切って入れ直すと改善することがあります。
        それでは、点検と修理にお伺いします。お伺いする日にちと時間のご希望を教えてください。
お客様: 明日の午前中
AI    : 明日の午前中ですね。お名前を教えてください。
```

対応する業務: 水道（蛇口・キッチン・トイレ・お風呂・洗面台の水漏れ / 詰まり / 交換）、給湯器（故障 / 交換）、排水・下水（屋外排水・マスの詰まり、高圧洗浄）、水栓・トイレリフォーム（ウォシュレット取付、トイレ本体・洗面台交換）。訪問の受付はモックで、実際の予約システムには登録しません。

## 目次

1. [前提](#前提)
2. [セットアップ](#セットアップ)
3. [起動と動作確認](#起動と動作確認)
4. [試してみるセリフ](#試してみるセリフ)
5. [環境変数](#環境変数)
6. [カスタマイズ](#カスタマイズ)
7. [エンドポイント](#エンドポイント)
8. [ログの見方](#ログの見方)
9. [トラブルシューティング](#トラブルシューティング)
10. [ディレクトリ構成](#ディレクトリ構成)
11. [本番で動かす前に](#本番で動かす前に)

## 前提

| 必要なもの | 用途 | 取得先 |
| --- | --- | --- |
| Node.js 20 以上（22 で動作確認） | サーバー | https://nodejs.org/ |
| Twilio アカウント | 電話 / ConversationRelay / ブラウザ通話 | https://console.twilio.com/ |
| TypeSafe AI の API キー | Jev による判定 | https://docs.typesafe.ai/ |
| OpenAI の API キー | FAQ 回答と一言アドバイスの生成 | https://platform.openai.com/ |
| ngrok の authtoken（ローカル開発時） | Twilio からローカルへ到達させるトンネル | https://dashboard.ngrok.com/get-started/your-authtoken |

Twilio 側で **ConversationRelay の利用同意**が必要です。Console の **Voice → Settings → General** で *Predictive and Generative AI/ML Features Addendum* に同意してください。同意していないと、つながってすぐ切れます。

電話番号がなくても試せます。ブラウザの「AI Call」ボタンから同じ受付フローに発信できます（後述）。

## セットアップ

### 1. 依存関係を入れる

```bash
git clone https://github.com/MitsuharuNakamura/ivr-with-jev-twilio.git
cd ivr-with-jev-twilio
npm install
```

### 2. Twilio で 3 つ用意する

1. **Account SID と Auth Token**: Console のトップに表示されています。
2. **API キー（Standard）**: Console → Account → API keys & tokens → Create API key。SID（`SK…`）と Secret を控えます（Secret は作成時しか見られません）。ブラウザ通話のトークン発行と、TwiML App の URL 自動更新に使います。
3. **TwiML App**: Console → Voice → Manage → TwiML Apps → Create。名前は任意（例: `ai-ivr-jev`）。Voice Request URL は**空のままで構いません**（起動時にサーバーが自動で設定します）。SID（`AP…`）を控えます。

電話番号からも受けたい場合は、その番号の **Phone Number SID**（`PN…`）も控えておきます（Console → Phone Numbers → 番号を開くと URL に含まれています）。

### 3. `.env` を作る

```bash
cp .env.example .env
```

最低限、次を埋めます。

```dotenv
# ローカル開発: ngrok を内蔵で起動し、払い出された URL を Twilio に自動設定する
NGROK_ENABLED=true
NGROK_AUTHTOKEN=<ngrok の authtoken>

TYPESAFE_API_KEY=<TypeSafe の API キー>
OPENAI_API_KEY=<OpenAI の API キー>

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=<Auth Token>          # Twilio からのリクエスト署名を検証する
TWILIO_API_KEY_SID=SK...
TWILIO_API_KEY_SECRET=<API キーの Secret>
TWILIO_TWIML_APP_SID=AP...

# 電話番号からも受ける場合（任意）
TWILIO_PHONE_NUMBER_SID=PN...
```

`.env` は `.gitignore` 済みです。コミットしないでください。

### 4. テストが通ることを確認する

```bash
npm test
```

外部 API には接続しません（Jev / OpenAI / Twilio はすべてモック）。

## 起動と動作確認

```bash
npm run dev
```

起動すると次の順で進み、最後に `ready` が出ます。

1. ngrok のトンネルを開き、そのホスト名を公開ホストとして採用
2. HTTP / WebSocket サーバーを起動
3. Twilio の TwiML App（と `TWILIO_PHONE_NUMBER_SID` を設定した番号）の Voice URL を `https://<トンネル>/twiml` に更新
4. `ready` ログに `twiml`（Twilio 用 URL）と `aiCall`（ブラウザ通話の URL）を表示

```json
{"msg":"ngrok tunnel open","url":"https://xxxx.ngrok-free.app"}
{"msg":"Twilio voice webhook updated","kind":"TwiML App","voiceUrl":"https://xxxx.ngrok-free.app/twiml"}
{"msg":"ready","twiml":"https://xxxx.ngrok-free.app/twiml","aiCall":"https://xxxx.ngrok-free.app/phone"}
```

### ブラウザから通話する

`ready` ログの `aiCall` の URL（`https://<トンネル>/phone`）をブラウザで開き、「AI と通話する」を押します。

- 無料プランの ngrok は初回に確認画面が出ます。「Visit Site」で進めます。
- マイクの許可が求められます（HTTPS か localhost が必要）。
- 画面右の「会話の内訳」に、ターンごとに **Jev だけ（定型文）か Jev + OpenAI か**のバッジ、Jev / OpenAI / サーバーの処理時間、体感の待ち時間（マイクが静かになってから AI の声が始まるまで。ヘッドホン推奨）が出ます。
- 通話中の「オペレーターへ」ボタンで有人転送（DTMF 0）を試せます。

### 電話番号から通話する

`.env` に `TWILIO_PHONE_NUMBER_SID` を設定していれば、起動時にその番号の Voice URL も更新されます。設定していない場合は、Console → Phone Numbers → 番号 → Voice Configuration の *A call comes in* を `https://<トンネル>/twiml`（HTTP POST）に手で設定してください。

無料プランの ngrok は起動のたびに URL が変わります。毎回自動で更新されるので操作は不要ですが、固定したい場合は ngrok の Reserved Domain を取得して `NGROK_DOMAIN` に設定してください。

### 停止する

`Ctrl+C` でサーバーとトンネルが閉じます。Twilio 側の Voice URL は元に戻しません（次回起動時に上書きされます）。

## 試してみるセリフ

| 話しかけ方 | 期待される流れ |
| --- | --- |
| 「給湯器が故障してお湯が出ない」→「全然出ない」→「**111** が出てます」 | 給湯器の故障ですね → 確認 2 問 → ありがとうございます。（OpenAI）点火不良の対処 → お伺いする日にちと時間は？ |
| 「トイレが詰まった」→「ゆっくりなら流れる」→「心当たりはない」 | トイレの詰まりですね → 確認 2 問 →（OpenAI）水を流すのはやめてラバーカップを… → 日時の質問 |
| 「水が止まらない、床が水浸し」→「お風呂です」 | **緊急**: まず止水栓か元栓を閉めてください → どちらの水漏れですか → できるだけ早くお伺いします。お名前は？（日時は聞かない） |
| 「ウォシュレットを付けたい」→「コンセントはある」→「まだ買ってない」 | ウォシュレットの交換ですね → 確認 2 問 →（OpenAI）取り付けは約 1 時間、工事費は… → 日時の質問 |
| 受付の途中で「止水栓ってどこですか」 | 少々お調べしますのでお待ちください（即時）→（OpenAI）トイレの止水栓はタンク横の… → 聞きかけの質問に戻る |
| 「オペレーターにつないで」／ キーパッドの 0 | 有人転送（`HANDOFF_PHONE_NUMBER` 未設定ならお詫びして終了） |
| 「大丈夫です」「特にないです」 | お礼を述べて終話 |

## 環境変数

`.env.example` に全項目とコメントがあります。主なもの:

### 必須

| 変数 | 説明 |
| --- | --- |
| `TYPESAFE_API_KEY` | TypeSafe AI の API キー |
| `OPENAI_API_KEY` | OpenAI の API キー |
| `TWILIO_ACCOUNT_SID` | `AC…` |
| `PUBLIC_HOST` または `NGROK_ENABLED=true` | Twilio から到達できるホスト名。ngrok 内蔵を使うなら `PUBLIC_HOST` は空でよい |

### 公開ホスト / ngrok

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `NGROK_ENABLED` | `false` | `true` で起動時にトンネルを開く。`NGROK_AUTHTOKEN` が必要 |
| `NGROK_AUTHTOKEN` | — | ngrok の authtoken |
| `NGROK_DOMAIN` | — | Reserved Domain を使う場合 |
| `TWILIO_SYNC_WEBHOOKS` | `true` | 起動時に TwiML App / 電話番号の Voice URL を自動更新する |
| `TWILIO_PHONE_NUMBER_SID` | — | 自動更新の対象にする電話番号（`PN…`） |
| `PUBLIC_HOST` | — | 固定ホストで動かすとき（本番など）。`NGROK_ENABLED=false` で使用 |

### Twilio / ブラウザ通話

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `TWILIO_AUTH_TOKEN` | — | 設定すると `/twiml*` と WebSocket で `X-Twilio-Signature` を検証する。本番では必須 |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` / `TWILIO_TWIML_APP_SID` | — | 3 つ揃うとブラウザ通話（`/phone`）が有効になる。Voice URL の自動更新にも使う |
| `BROWSER_PHONE_PASSCODE` | — | `/phone` からの発信に必要なパスコード（8 文字以上）。`NODE_ENV=production` では必須。未設定だと URL を知る人は誰でもあなたの Twilio 課金で発信できる |
| `HANDOFF_PHONE_NUMBER` | — | 有人転送先（E.164）。未設定なら「おつなぎできません」と案内して終了 |
| `HANDOFF_CALLER_ID` | — | 転送時の発信者番号。ブラウザ発信の `From` は電話番号ではないので、転送を使うなら所有する Twilio 番号を設定 |

### 判定のしきい値

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `CONFIDENCE_THRESHOLD` | `0.65` | 「何を求めているか分かる」確率がこれ未満なら聞き返す。Choice の採用基準にも使う |
| `REQUIRES_HUMAN_THRESHOLD` | `0.7` | これ以上で有人転送 |
| `SLOT_THRESHOLD` | `0.6` | 「今の発話は聞いていた答えか」の採用基準 |
| `EMERGENCY_THRESHOLD` | `0.7` | これ以上で応急処置を先に案内し、日時を飛ばして最短受付 |
| `MAX_CLARIFY_FAILURES` | `2` | 連続でこの回数聞き取れなければ有人転送 |
| `TRIAGE_ADVICE` | `true` | 切り分け後に状況確認と一言アドバイスを挟む。`false` で定型文のみ |
| `ADVICE_MAX_CHARS` / `FAQ_MAX_CHARS` | `60` / `100` | OpenAI が生成する文の上限文字数 |

### 音声

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `TTS_LANGUAGE` | `ja-JP` | |
| `TTS_PROVIDER` / `TTS_VOICE` | `Google` / `ja-JP-Neural2-B` | Twilio 既定の音声は日本語の漢字を誤読することがあるため、日本語ネイティブの音声を推奨 |
| `TRANSCRIPTION_PROVIDER` / `SPEECH_MODEL` | — | 空なら Twilio の既定 |

## カスタマイズ

コードを触らずに変えられるもの:

| 変えたいこと | 場所 |
| --- | --- |
| **エラーコードと対処**（例: お風呂のリモコンの 111） | `src/errorCodes.json`。1 件 = `code` / `equipment` / `meaning` / `action` / `needsVisit`。追加して再起動。書式ミスは起動時と `npm test` で検出。初期の 3 件はサンプルなので、扱うメーカーの取扱説明書に合わせて書き換えてください |
| **FAQ ナレッジ**（料金、営業時間、応急処置） | `src/mockKnowledge.json`。`category`（WATER / HEATER / DRAINAGE / REMODEL）と `equipment[]` で絞り込みに使われます。`equipment` が空なら全員向け（営業時間など） |
| **しきい値** | `.env`（上記） |

コードで変えるもの:

| 変えたいこと | 場所 |
| --- | --- |
| 定型文（挨拶、聞き返し、復唱、緊急案内） | `src/config/messages.ts` |
| 機器・症状の語彙と、(機器, 症状) → 業務カテゴリの変換表 | `src/config/serviceCatalog.ts` |
| 状況確認の質問（機器・症状ごとに 1〜2 問） | `src/config/serviceCatalog.ts` の `detailQuestions` |
| Jev に聞く質問文・判定基準 | `src/services/jevService.ts` |
| OpenAI のプロンプト | `src/services/openAiService.ts` |
| 会話の流れ（どのターンで何をするか） | `src/services/stateMachine.ts`（純粋関数） |
| 受付の登録・照会（現在はモック） | `stateMachine.ts` の `fillSlot` で `visitDone` / `statusResult` を返している箇所 |

エラーコードの検出は、音声認識が「一一一」「いちいちいち」のように漢字・かなで返しても数字に直して照合します。表にないコードは「登録なし」として LLM に渡すので、意味を推測せず「訪問時に確認します」と答えます。

## エンドポイント

| パス | 用途 |
| --- | --- |
| `GET/POST /twiml` | Twilio が最初に取りに来る TwiML（`<Connect><ConversationRelay>`） |
| `WS /relay` | ConversationRelay の WebSocket セッション |
| `POST /twiml/handoff` | セッション終了時のコールバック。有人転送時は案内を `<Say>` して `<Dial>` |
| `GET /health` | ヘルスチェック |
| `GET /phone` | ブラウザ通話の画面（3 つの Twilio 設定が揃ったときのみ）。`?watch=<identity>` で他の通話のタイムラインだけ表示 |
| `GET /phone/events` | 通話の進行を SSE で配信（画面の「会話の内訳」用） |
| `POST /phone/token` | ブラウザ通話用のアクセストークン発行 |

## ログの見方

`npm run dev` の標準出力に JSON で 1 行ずつ出ます（`npm run dev > .logs/server.log 2>&1` のようにリダイレクトすると後から見返せます。`.logs/` は gitignore 済み）。1 ターンごとの主なフィールド:

| フィールド | 意味 |
| --- | --- |
| `utterance` | 文字起こし（Twilio から届いた確定テキスト） |
| `intent` / `intentConfidence` / `isConfident` / `requiresHuman` | 毎ターンの 3 判定 |
| `triage.equipment` / `triage.symptom` / `triage.emergency` | 切り分けターンの判定と確信度 |
| `expecting` / `provides` / `confirmation` | 待っていた答えの種類と、答えになっていた確率 |
| `jevMs` | Jev の応答時間。`degraded: true` なら Jev に届かず縮退判定（聞き返しになる） |
| `action` | `say`（定型文）/ `faq`（OpenAI を挟む）/ `handoff` |
| `deep path spoken` 行の `purpose` / `openAiMs` / `knowledgeIds` | OpenAI の用途（`answer` / `advice`）、所要時間、根拠にしたナレッジ |

同じ内容はブラウザ通話の画面右「会話の内訳」でも見られます。文字起こしを含むため、本番ではログの保管先と保持期間に注意するか `LOG_LEVEL=warn` にしてください。

## トラブルシューティング

| 症状 | 確認すること |
| --- | --- |
| 起動時に `Invalid environment configuration` | メッセージに足りない変数が列挙されます。`NGROK_ENABLED=true` なら `NGROK_AUTHTOKEN`、`false` なら `PUBLIC_HOST` が必要。ブラウザ通話の 3 変数は全部揃えるか全部空に |
| `Could not start the ngrok tunnel … ERR_NGROK_105` | authtoken が違います。ダッシュボードの値をそのまま貼ってください |
| `Twilio voice webhook update FAILED` | API キーか TwiML App SID が違います。サーバーは起動しているので、ログの `voiceUrl` を Console で手動設定しても動きます |
| つながった直後に切れる | ConversationRelay の利用同意（Addendum）が未了。Console → Voice → Settings → General |
| `/twiml` が 403 | `TWILIO_AUTH_TOKEN` が Twilio の実際の Auth Token と違う、または `PUBLIC_HOST` と Twilio がアクセスした URL が食い違っている（署名は URL 全体で計算されます） |
| 「音声ストリームを取得できず…」 | 古い版のメッセージです。現在は Voice SDK の音量イベントで計測するので、最新のコードでは出ません |
| 体感待ち時間が出ない / おかしい | スピーカーだと AI の声をマイクが拾います。ヘッドホンで試してください |
| 読み上げが変（漢字の誤読） | `TTS_PROVIDER=Google` / `TTS_VOICE=ja-JP-Neural2-B` になっているか確認 |
| Jev が `degraded: true` ばかり | `TYPESAFE_API_KEY` を確認。一時的な 503 なら 1 回リトライした上で聞き返しに落ちます |

## ディレクトリ構成

```
src/
├── config/
│   ├── env.ts                 # 環境変数の検証（zod）
│   ├── serviceCatalog.ts      # 機器・症状の語彙、(機器, 症状) → 業務カテゴリ、状況確認の質問
│   └── messages.ts            # 定型文
├── types/
│   ├── conversation-relay.ts  # ConversationRelay の WebSocket メッセージ型
│   └── jev.ts                 # Jev API のリクエスト / レスポンス型
├── services/
│   ├── jevService.ts          # Jev クライアント（1 ターン 1 リクエスト、期限付きリトライ、縮退）
│   ├── openAiService.ts       # FAQ 回答と一言アドバイスの生成
│   ├── knowledgeSearch.ts     # ナレッジ検索（文字 bigram + キーワード + カテゴリ/機器ボーナス）
│   ├── errorCodes.ts          # 発話からエラーコードを拾い、表と照合して LLM に渡す
│   ├── slotExtraction.ts      # 日時・名前・住所・番号を発話から抜き出す
│   ├── stateMachine.ts        # 会話の状態遷移（純粋関数）: (state, 判定) → (state, アクション)
│   ├── callEvents.ts          # ブラウザ画面向けのターンイベント
│   ├── tunnelService.ts       # ngrok トンネルの起動 / 停止
│   └── twilioWebhookService.ts # TwiML App / 電話番号の Voice URL 更新
├── handlers/relayHandler.ts   # WebSocket セッション処理（cushion → OpenAI → followUp、割り込み）
├── routes/
│   ├── twiml.ts               # /twiml, /twiml/handoff
│   └── browserPhone.ts        # /phone, /phone/token, /phone/events
├── utils/                     # X-Twilio-Signature 検証、Voice アクセストークン生成
├── startup.ts                 # 公開ホストの決定と Twilio Webhook 同期
├── server.ts                  # Fastify の組み立て
├── index.ts                   # エントリーポイント
├── mockKnowledge.json         # FAQ ナレッジ（編集可）
└── errorCodes.json            # エラーコード表（編集可）
public/phone.html              # ブラウザ通話の画面（Twilio Voice JS SDK）
tests/                         # Vitest（外部 API はモック）
```

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発起動（tsx watch） |
| `npm run build` / `npm start` | `dist/` にビルドして起動 |
| `npm test` / `npm run test:coverage` | テスト（カバレッジ閾値 80%） |
| `npm run typecheck` | 型チェックのみ |

## 本番で動かす前に

- **公開ホスト**: `NGROK_ENABLED=false` にして `PUBLIC_HOST` に固定ホスト名を設定し、Twilio Console で電話番号の Voice URL を `https://<PUBLIC_HOST>/twiml` に設定してください。
- **署名検証**: `TWILIO_AUTH_TOKEN` を必ず設定してください（Twilio 以外からのリクエストを拒否します）。
- **ブラウザ通話**: 公開するなら `BROWSER_PHONE_PASSCODE` を設定してください（`NODE_ENV=production` では起動時に必須チェックされます）。
- **受付の登録**: 現在はモックです。`stateMachine.ts` は純粋関数のままにして、`visitDone` を返すアクションを受け取った側（`relayHandler.ts`）から予約システムを呼ぶ形で接続してください。日時・住所は発話のまま保持しているので（「明日の3時」「世田谷区…」）、登録には正規化が必要です。
- **ナレッジ検索**: `knowledgeSearch.ts` は簡易実装です。`searchKnowledge` の戻り値の形を保てば、ベクトル検索などに差し替えられます。
- **しきい値**: 既定値は本物の Jev でのシミュレーションから決めた出発点です。通話ログの `utterance` と判定値を見て調整してください。
- **複数インスタンス**: セッション状態は WebSocket 接続に紐づくため共有不要ですが、レート制限のストアは Redis などに切り替えてください。
