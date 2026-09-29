# ai-ivr-jev

Twilio ConversationRelay × TypeSafe AI (Jev) × OpenAI による、水まわり修理業者向けのハイブリッド音声自動応答サーバー。

- **Twilio ConversationRelay** が STT / TTS / 割り込み (barge-in) を担当し、サーバーとは WebSocket (JSON) で通信
- **Jev** が毎ターン数百 ms で「意図・機器・症状・緊急度・有人要否」を判定し、コードが分岐を決める
- 切り分け・聞き取り・復唱・緊急案内は **固定テンプレートを即返信**（LLM を通らない Fast Path）
- 対処方法・料金などの **具体的な質問だけ GPT-4o-mini**（判定済みカテゴリのナレッジに絞る Deep Path）

対応する業務: 水道（蛇口・キッチン・トイレ・お風呂・洗面台の水漏れ / 詰まり / 交換）、給湯器（ガス給湯器・電気温水器・エコキュートの故障 / 交換）、排水・下水（屋外排水・マスの詰まり、高圧洗浄）、水栓・トイレリフォーム（ウォシュレット取付、トイレ本体・洗面台交換）

```
発話 ─▶ Twilio STT ─▶ {"type":"prompt"} ─▶ Jev（1リクエストで並列判定: intent / is_confident / requires_human ＋ 状況に応じた追加質問）
                                             │
      requires_human ≥ 0.7 ─────────────────┼─▶ 有人転送  {"type":"end", handoffData}
      待っていた答え (機器/症状/日時/名前/住所/はい・いいえ) ┼─▶ 次の質問へ進む / 受付完了     ← Fast Path
      TROUBLE ──────────────────────────────┼─▶ 機器×症状で切り分け → 「キッチンの水漏れですね」＋状況確認の質問 (1〜2問, 定型) → OpenAI の一言 → 日時の質問
      is_emergency ≥ 0.7 ───────────────────┼─▶ 応急処置の定型文 → 日時を飛ばして最短で受付        ← Fast Path
      UNKNOWN or is_confident < 0.65 ───────┼─▶ 聞き返し（2回連続で有人転送）
      KNOWLEDGE_FAQ ────────────────────────┼─▶ クッション発話 → カテゴリ別ナレッジ検索 → OpenAI → 回答 → 聞きかけの質問に戻る ← Deep Path
      HUMAN_HANDOFF ────────────────────────┼─▶ 有人転送
      CLOSING (「大丈夫です」) ───────────────┴─▶ お礼を述べて終話
```

## このデモのシナリオ

**水まわり修理業者の一次受付**を AI が担当します。お客様は電話番号にかけるか、ブラウザの「AI Call」ボタンで話しかけます。AI は次の順で応対し、人が出るのは有人転送のときだけです。

1. **切り分け**（Jev）: 発話から機器（キッチン・トイレ・お風呂・給湯器…）と症状（水漏れ・詰まり・故障・交換・高圧洗浄）を判定し、「給湯器の故障ですね。」と復唱
2. **状況確認**（Jev ＋ 定型文）: コールセンターのように 1〜2 問。「お湯はまったく出ませんか」「お風呂のリモコンにエラー番号は出ていますか」
3. **一言アドバイス**（OpenAI）: 聞いた内容とナレッジ、発話されたエラーコードの意味をふまえて、今できる確認や応急処置を 60 文字以内で
4. **訪問の受付**（Jev ＋ 定型文）: 日時 → 名前 → 住所 → 復唱 → 完了（登録はモック）
5. 途中の質問（「止水栓はどこ」「いくらかかる」）には OpenAI が答えて、聞きかけの質問に戻る。緊急（水が止まらない等）は応急処置を先に案内して最短で受付。「大丈夫です」で終話

### 試してみるセリフ

| 話しかけ方 | 期待される流れ |
| --- | --- |
| 「給湯器が故障してお湯が出ない」→「全然出ない」→「**111** が出てます」 | 給湯器の故障ですね → 確認 2 問 → ありがとうございます。（OpenAI）点火不良の表示です。ガスの元栓を確認し、運転を入れ直してください → お伺いする日にちと時間は？ |
| 「トイレが詰まった」→「ゆっくりなら流れる」→「心当たりはない」 | トイレの詰まりですね → 確認 2 問 → （OpenAI）水を流すのはやめてラバーカップを… → 日時の質問 |
| 「水が止まらない、床が水浸し」→「お風呂です」 | **緊急**: まず止水栓か元栓を閉めてください → どちらの水漏れですか → お風呂の水漏れですね。できるだけ早くお伺いします。お名前は？（日時は聞かない） |
| 「ウォシュレットを付けたい」→「コンセントはある」→「まだ買ってない」 | ウォシュレットの交換ですね → 確認 2 問 → （OpenAI）取り付けは約 1 時間、工事費は… → 日時の質問 |
| 受付の途中で「止水栓ってどこですか」 | 少々お調べしますのでお待ちください（即時）→（OpenAI）トイレの止水栓はタンク横の… → 聞きかけの質問に戻る |
| 「オペレーターにつないで」／ キーパッドの 0 | 有人転送（`HANDOFF_PHONE_NUMBER` 未設定ならお詫びして終了） |

ブラウザ画面の右側「会話の内訳」で、各ターンが **Jev だけ（定型文）** か **Jev + OpenAI** か、Jev / OpenAI / サーバーの処理時間、体感の待ち時間が確認できます。

## セットアップ

```bash
npm install
cp .env.example .env      # TYPESAFE_API_KEY / OPENAI_API_KEY / TWILIO_ACCOUNT_SID を設定
npm run dev
```

### ngrok 内蔵（ローカル開発向け）

`.env` に `NGROK_ENABLED=true` と `NGROK_AUTHTOKEN` を設定すると、ngrok を別ターミナルで動かす必要はありません。

1. サーバー起動時に ngrok トンネルを開く（ngrok の CLI は不要。`@ngrok/ngrok` を利用）
2. 払い出された URL のホスト名を `PUBLIC_HOST` として採用（TwiML の `wss://…/relay` や署名検証に反映）
3. Twilio REST API で **TwiML App の Voice URL を `https://<払い出しURL>/twiml` に更新**（`TWILIO_PHONE_NUMBER_SID` を設定すれば電話番号の Webhook も同時に更新）
4. `Ctrl+C` / SIGTERM でサーバーを止めるとトンネルも閉じる

起動ログの `ready` に `twiml` と `aiCall` (AI Call ボタンの URL) が出るので、それを開けばすぐ試せます。

- Webhook 更新の認証は API キー (`TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`) を優先し、無ければ `TWILIO_AUTH_TOKEN` を使います。
- 更新に失敗してもサーバーは起動し続け、エラーログに手動設定すべき URL を出します。自動更新を止めるには `TWILIO_SYNC_WEBHOOKS=false`。
- 停止時に Voice URL は元に戻しません（次回起動時に上書きされます）。無料プランは起動ごとに URL が変わるため、`NGROK_DOMAIN` に固定ドメインを設定すると安定します。
- 本番など固定ホストで動かす場合は `NGROK_ENABLED=false`（既定）のまま `PUBLIC_HOST` を設定し、Twilio Console で電話番号の **A call comes in** を `https://<PUBLIC_HOST>/twiml` (HTTP POST) に設定します。

ConversationRelay の利用には Console の Voice 設定で *Predictive and Generative AI/ML Features Addendum* への同意が必要です。

### AI Call ボタン / ブラウザ通話（任意）

電話番号は不要です。`/phone` の「AI と通話する」ボタンを押すだけで、ブラウザのマイクから同じ IVR ロジックと通話できます。

1. Twilio Console → **Voice > TwiML Apps** で TwiML App を作成し、Voice Request URL を `https://<PUBLIC_HOST>/twiml` (POST) に設定
2. **Account > API keys & tokens** で Standard API キーを作成
3. `.env` に `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` / `TWILIO_TWIML_APP_SID` を設定して再起動（3つ揃ったときだけ機能が有効化されます）
4. `https://<PUBLIC_HOST>/phone` を開いて「AI と通話する」（マイク利用のため HTTPS か localhost が必要）

ブラウザ → Twilio → TwiML App → `/twiml` → ConversationRelay → `/relay` と流れるため、PSTN 着信と完全に同じ経路・同じ判定ロジックで処理されます。通話中の「オペレーターへ」ボタンで有人転送 (DTMF 0) も試せます。

- トークン発行 `/phone/token` は誰でも叩けると **あなたの Twilio アカウントの課金で発信できてしまう** ため、`BROWSER_PHONE_PASSCODE` の設定を推奨します（`NODE_ENV=production` では必須）。発行トークンは発信専用 (outgoing grant のみ)・既定 1 時間有効で、発行は IP あたり 10 回/分に制限しています。
- 画面右の「会話の内訳」には、ターンごとに **Jev だけで答えたか（定型文）／OpenAI が生成したか** のバッジと、Jev・OpenAI・サーバー全体の処理時間、さらに「体感」（ブラウザのマイクが静かになってから受話音声が始まるまで。ヘッドホン推奨）が出ます。仕組みは、発信時の `identity` を TwiML の `<Parameter>` で relay に渡し、サーバーがターンごとのイベントを `/phone/events`（SSE）で画面に流しています。
- ブラウザ発信の `From` は `client:browser-xxxx` になり電話番号ではないため、有人転送の `<Dial>` を使う場合は `HANDOFF_CALLER_ID`（所有する Twilio 番号）を設定してください。

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | tsx watch で起動 |
| `npm run build` / `npm start` | `dist/` にビルドして起動 |
| `npm test` / `npm run test:coverage` | Vitest（カバレッジ閾値 80%） |
| `npm run typecheck` | `tsc --noEmit` |

## エンドポイント

| パス | 用途 |
| --- | --- |
| `GET/POST /twiml` | `<Connect><ConversationRelay>` を返す初期 TwiML |
| `WS /relay` | ConversationRelay セッション |
| `POST /twiml/handoff` | `<Connect action>` コールバック。有人転送時は案内を `<Say>` して `<Dial>` |
| `GET /health` | ヘルスチェック |
| `GET /phone` | AI Call ボタンの画面（有効時のみ）。`?watch=<identity>` で他の通話のタイムラインだけ表示 |
| `GET /phone/events` | 通話の進行を SSE で配信（`identity` ごと。画面の「会話の内訳」用） |
| `POST /phone/token` | Voice SDK 用アクセストークン発行（有効時のみ） |

## ディレクトリ構成

```
src/
├── config/
│   ├── env.ts                 # zod による環境変数の検証
│   ├── serviceCatalog.ts      # 機器・症状の語彙、(機器, 症状) → 業務カテゴリの変換表
│   └── messages.ts            # 定型発話テンプレート（応急処置・復唱の文も）
├── types/
│   ├── conversation-relay.ts  # ConversationRelay の WebSocket メッセージ型 (zod)
│   └── jev.ts                 # Jev API のリクエスト / レスポンス型 (zod)
├── services/
│   ├── jevService.ts          # Jev クライアント（undici keep-alive、期限付きリトライ、縮退）
│   ├── openAiService.ts       # FAQ 回答生成（プロンプト、100文字クランプ）
│   ├── slotExtraction.ts      # 日時・名前・住所・番号を発話から抜き出す
│   ├── knowledgeSearch.ts     # ダミー RAG（文字 bigram + キーワード + カテゴリ/機器ボーナス）
│   ├── errorCodes.ts          # 発話からエラーコードを拾い、表と照合して LLM に渡す
│   ├── stateMachine.ts        # 純粋関数の状態遷移: (state, judgment) → (state, action)
│   ├── tunnelService.ts       # ngrok トンネルの起動 / 停止
│   └── twilioWebhookService.ts # TwiML App / 電話番号の Voice URL 更新
├── handlers/relayHandler.ts   # WebSocket セッション処理
├── routes/
│   ├── twiml.ts               # /twiml, /twiml/handoff
│   └── browserPhone.ts        # /phone, /phone/token（ブラウザ電話）
├── utils/                     # X-Twilio-Signature 検証、Voice アクセストークン生成
├── startup.ts                 # 公開ホストの決定 (ngrok / PUBLIC_HOST) と Twilio Webhook 同期
├── server.ts                  # Fastify 組み立て（テスト用に DI 可能）
├── index.ts                   # エントリーポイント
├── mockKnowledge.json         # FAQ ダミーナレッジ
└── errorCodes.json            # エラーコード表（編集して追加）
public/phone.html              # ブラウザ電話の UI（Twilio Voice JS SDK）
```

## 設計メモ

### ConversationRelay のメッセージ形式
Twilio → サーバーの発話確定は `{"type":"prompt","voicePrompt":"…","last":true}` です。
サーバー → Twilio の読み上げは **`{"type":"text","token":"…","last":true}`**（`prompt` ではありません）、
終了・転送は `{"type":"end","handoffData":"…"}` です（[公式リファレンス](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages)）。

### Jev への質問
`POST https://api.typesafe.ai/v1/systemone` に、毎ターン 3 つの質問を **1 リクエスト** で送ります（互いに独立なので並列評価される）。

| id | 型 | 内容 |
| --- | --- | --- |
| `intent` | Choice | `TROUBLE`（不具合の相談・修理希望）/ `STATUS_CHECK` / `KNOWLEDGE_FAQ` / `HUMAN_HANDOFF` / `CLOSING` / `UNKNOWN` |
| `is_confident` | Noul | どんな助けを求めているか分かるほど発話が明確か |
| `requires_human` | Noul | 怒り・苦情・法的な話など有人対応が必要か（水の緊急事態は自動受付が扱うので含めない） |

加えて、**会話の段階に応じた質問を同じリクエストに相乗り**させます（追加の往復なし）。

| 段階 | 相乗りする質問 | コード側の処理 |
| --- | --- | --- |
| 用件待ち・切り分け中 | `equipment` Choice（蛇口 / キッチン / トイレ / お風呂 / 洗面台 / 給湯器 / 屋外排水 / ウォシュレット / 不明）、`symptom` Choice（水漏れ / 詰まり / 故障 / 交換 / 高圧洗浄 / 不明）、`is_emergency` Noul | `categoryOf(機器, 症状)` の表で 4 業務カテゴリに変換（`src/config/serviceCatalog.ts`）。片方だけ分かれば残りを聞く |
| 状況確認中 | `answers_question` Noul（直前の質問への答えか） | 発話を整形してそのまま保持し、OpenAI に渡す |
| 日時待ち | `provides_datetime` Noul | 発話から日時表現を正規表現で抜き出し |
| 名前待ち | `provides_name` Noul | 前置き・語尾を除去 |
| 住所待ち | `provides_address` Noul | 発話のまま保持（正規化はしない） |
| 復唱への返事 | `confirmation` Choice (YES / NO / NEITHER) | — |

Jev は「その発話が答えになっているか」「どの機器・症状か」を判定するだけで、値そのものは発話者の言葉からコードがコピーします（生成しない）。
「トイレの水漏れ」＝水道、「トイレ本体の交換」＝リフォームのように、業務カテゴリは機器と症状の組み合わせで決まるため、Jev にカテゴリを直接選ばせず、コードの表で変換しています。

受付フローは「切り分け → 状況確認 → 一言アドバイス → 日時 → 名前 → 住所 → 復唱して確認 → 完了」。切り分けが確定すると、コールセンターのようにまず状況を確認します（機器・症状ごとに 1〜2 問の定型文。`serviceCatalog.ts` の `detailQuestions`。答えは Jev の `answers_question` Noul で「質問への答えか」だけ判定し、発話のまま保持）。全部聞き終えたら「ありがとうございます。」を即時に流し、最初の申告と確認の答えをまとめて OpenAI に渡して一言（故障なら今すぐできる確認や応急処置、交換・高圧洗浄なら作業の概要や料金の目安）を約 1 秒で生成、続けて日時を尋ねます（`TRIAGE_ADVICE=false` で確認と一言を省き定型文のみに戻せます）。最初の発話で機器と症状が揃えば切り分けの質問は省略、緊急なら応急処置（水漏れは止水栓、詰まりは水を流さない、給湯器はガスの元栓）を先に案内して日時を飛ばし「できるだけ早く」で受付、復唱を否定されたら日時から取り直し、途中の FAQ には答えたうえで聞きかけの質問に戻ります。受付の登録・照会そのものはモックです（`stateMachine.ts` の `fillSlot`）。

`state` には最新の発話 `latest_caller_utterance` と直近の会話 `recent_turns` を渡し、「トイレです」のような短い答えも文脈で判定できるようにしています。
実測トークン: 切り分けターン（7 問）約 2,000、聞き取りターン（4 問）約 1,100（入力のみ課金、$0.042/M）。
しきい値 (`0.65` / `0.7` / `0.6` / `0.7`) は本物の Jev でのシミュレーションで決めた出発点です。通話ログで評価して調整してください。

### エラーコード表 (`src/errorCodes.json`)
お客様が口にした機器のエラーコード（例: お風呂のリモコンの「111」）の意味と対処を OpenAI に渡すための表です。**コードを触らずに JSON を編集するだけ**で追加・修正できます（再起動で反映。書式ミスは起動時と `npm test` で検出）。

```json
{
  "code": "111",
  "equipment": "WATER_HEATER",
  "meaning": "点火不良（お湯を沸かす火がつかない）",
  "action": "ガスの元栓が開いているか、ガスメーターが遮断されていないかを確認し、お風呂のリモコンの運転を一度切って入れ直してください。",
  "needsVisit": "再発する場合は点検が必要です。"
}
```

- `code`: 数字 1〜4 桁、または英字 1 文字＋数字（`111`, `E1`）。音声認識が「一一一」「いちいちいち」「いち、よん、ぜろ」のように漢字・かなで返しても、数字に直してから照合します（かなは 3 語以上続いたときだけ変換するので「に」「ご」のような助詞は誤変換しません）
- `equipment`: `serviceCatalog.ts` の機器 ID（`WATER_HEATER`, `TOILET` …）
- `meaning` / `action` / `needsVisit`: そのまま LLM の根拠になります。読み上げ前提で短く、断定してよい内容だけを書いてください
- 発話に含まれる 3〜4 桁の数字はすべて照合し、**表にないコードは「登録なし」として渡す**ので、LLM は意味を推測せず「訪問時に確認します」と答えます。コードが 1 つも拾えなかったときは、番号の復唱・意味の推測・「お伺いします」という約束をしないよう指示しています
- 一言アドバイスでは「お伺いします」という言葉を LLM に使わせません。直後にシステムが「点検と修理にお伺いします」と続けるため、混ざると意味が取れなくなるからです
- 初期の 3 件（111 / 140 / 888）は一般的な給湯器の表示をもとにした**サンプル**です。実際に扱うメーカーの取扱説明書に合わせて書き換えてください

### ナレッジ (`src/mockKnowledge.json`)
各エントリに `category`（4 業務カテゴリ）と `equipment[]`（対象機器、空なら営業時間などの共通項目）を持たせています。FAQ 回答時は Jev の切り分け結果でカテゴリ・機器が一致するエントリを優先し（フィルタではなくボーナス）、プロンプトに「お客様の状況: 水道の修理: トイレの詰まり」を添えるので、「止水栓はどこ」に対してトイレならタンク横、キッチンならシンク下、と状況に合った答えになります。

### 信頼性
- **Jev 障害時は縮退**: タイムアウト (`JEV_TIMEOUT_MS`、リトライ込みの総期限) / 5xx / 429 / 529 / スキーマ不一致は例外にせず `UNKNOWN` 判定として返し、聞き返し → 有人転送の通常フローに乗せます。
- **OpenAI 障害時**: FAQ 回答は謝罪テンプレートを返し、切り分け後の一言アドバイスは何も言わずに日時の質問へ進みます。どちらも通話は継続します。
- **古い結果の破棄**: ターン番号で管理し、Jev / OpenAI の応答待ち中に新しい発話が来たら古い結果は捨てます。FAQ 生成は `AbortController` で中断します。
- **相槌の保護**: クッション発話中の「はい」など `FAQ_BARGE_IN_MIN_CHARS` 未満の発話では FAQ 生成を中断しません。
- **転送案内は TwiML 側で発話**: `end` を送るとリレーが即終了し直前のテキストが途切れ得るため、案内文は `handoffData` に載せ `/twiml/handoff` の `<Say>` で読み上げてから `<Dial>` します。
- **WebSocket 異常終了時**（`SessionStatus=failed`）も `/twiml/handoff` で有人転送にフォールバックします。
- DTMF `0` でいつでもオペレーター転送。

### セキュリティ
- `TWILIO_AUTH_TOKEN` を設定すると `/twiml*` と WebSocket アップグレードで `X-Twilio-Signature` を検証します（本番では必須）。
- 全エンドポイントに IP 単位のレート制限、WebSocket は 64 KB のペイロード上限。
- 各ターンの文字起こしは `turn decided` ログの `utterance` に `info` レベルで出ます（判定の調整・デバッグ用）。個人情報を含み得るので、本番ではログの保管先と保持期間に注意するか、`LOG_LEVEL=warn` にしてください。
- ブラウザ通話のトークン発行 `/phone/token` は `BROWSER_PHONE_PASSCODE` で保護できます（`NODE_ENV=production` では必須）。

### ログの見方
`npm run dev` の標準出力に JSON で 1 行ずつ出ます（`npm run dev > .logs/server.log 2>&1` のようにリダイレクトすると後から見返せます。`.logs/` は gitignore 済み）。1 ターンごとの主なフィールド:

| フィールド | 意味 |
| --- | --- |
| `utterance` | 文字起こし（Twilio から届いた確定テキスト） |
| `intent` / `intentConfidence` / `isConfident` / `requiresHuman` | 毎ターンの 3 判定 |
| `triage.equipment` / `triage.symptom` / `triage.emergency` | 切り分けターンの判定と確信度 |
| `expecting` / `provides` / `confirmation` | 待っていた答えの種類と、答えになっていた確率 |
| `jevMs` | Jev の応答時間。`degraded: true` なら Jev に届かず縮退判定 |
| `action` | `say`（定型文）/ `faq`（OpenAI を挟む）/ `handoff` |
| `deep path spoken` 行の `purpose` / `openAiMs` / `knowledgeIds` | OpenAI の用途（`answer` / `advice`）、所要時間、根拠にしたナレッジ |

同じ内容はブラウザ通話の画面右「会話の内訳」でも、ターンごとに Jev / OpenAI のバッジと時間付きで見られます。

## 本番化に向けて
- 訪問受付の登録・照会はモックです（実際の受付システムには登録していません）。`stateMachine.ts` は純粋関数のままにして、`visitDone` を返すアクションからリポジトリを呼ぶ形で接続してください。
- 日時・住所は発話者の言葉のまま保持しています（「明日の3時」「世田谷区桜丘1丁目2の3」）。登録には日付への正規化、午前/午後の確認、住所の正規化が必要です。電話番号は PSTN 着信なら `From` を使えます。
- 緊急判定は `is_emergency` の Noul（既定 0.7）だけで決めています。通常の「水漏れしてて」でも 0.5〜0.6 が出るので、しきい値を下げる場合は実通話で確認してください。
- 音声は `TTS_PROVIDER=Google` / `TTS_VOICE=ja-JP-Neural2-B` を推奨値にしています。Twilio 既定 (ElevenLabs) は日本語の漢字を誤読することがありました。定型文も誤読されやすい漢字（受付・承る・日時）を避けています。
- 一言アドバイスは `ADVICE_MAX_CHARS`（既定 60）で長さを抑えていますが、LLM が確認済みの内容を聞き直すなど、プロンプトの指示を守らないことがまれにあります。目立つ場合は、確認の答えごとに定型文を用意する方式への切り替えを検討してください。
- エラーコード表 `src/errorCodes.json` の 3 件はサンプルです。運用前に、扱うメーカーの取扱説明書に合わせて書き換えてください。
- `knowledgeSearch.ts` はダミー実装です。`searchKnowledge` の戻り値の形を保ったままベクトル検索等に差し替えてください。
- 複数インスタンスで運用する場合、レート制限ストアを Redis に切り替えてください（セッション状態は WebSocket 接続に紐づくため共有不要）。
