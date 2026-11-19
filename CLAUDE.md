# ABYSSAL LEGENDS 開発ルール

ダークファンタジー放置RPG。ゲーム本体は `index.html` の1ファイルのみ（CSS・JS・画像をすべて内包）で、
GitHub Pages が `main` ブランチから公開しています。`main` に入った変更はそのまま公開サイトに出ます。
`main` はルールセットで保護されています（PR 必須・`test` 成功必須）。

## 標準の開発・公開手順

1. **最新の `main` から作業ブランチを作る。** セッションで指定された `claude/...` を使う。
   そのブランチの PR がマージ済みなら再利用せず、`git fetch origin main && git checkout -B <ブランチ> origin/main` で作り直す。
   `main` には直接プッシュしない（「リポジトリと公開のルール」）。
2. **修正前に既存コードとセーブ処理を読み、セーブへの影響を A/B/C に分類する**（「セーブデータのルール」）。
   C の場合は実装前にユーザーに相談し、了承を得てから進める。
3. **修正する。** ゲームの内容を変えたら `AL.CONFIG.GAME_VERSION` を上げる（例：1.0.0 → 1.0.1）。
   設定画面に表示されるため、公開後にスマホで反映を確かめる目印になる。セーブには影響しない。
4. **テストする。** `npm ci` → `npm test`。変更に合わせてテストを追加する（「テスト」）。
   実行できなかった項目は、その旨を報告する。
5. **失敗したら原因を調べて直し、再テストする。** テストを削除・スキップ・緩和（期待値を弱める、
   確認項目を減らす等）して成功扱いにしない。テストの前提が本当に変わった場合は、理由を報告して相談する。
6. **報告してから PR を作る。** 変更内容・テスト結果・セーブへの影響（A/B/C）・未確認事項をユーザーに報告し、
   `.github/pull_request_template.md` の項目を埋めて `main` 向けの PR を作る。
7. **GitHub Actions の `test` が成功したことを確認して報告する。**
8. **ユーザーが「公開して」と明示したときだけマージする。** テスト済みのコミットが PR の最新であることを確かめてからマージする。
9. **マージ後、Pages の公開結果を確認する。**
   - `pages build and deployment` の build・deploy が成功していること。
   - build ログの公開ファイル一覧が `index.html`・`README.md`・`og-image.png`・`assets/css/style.css` だけであること。
   - Claude Code のクラウド環境からは公開URL（`github.io`）に接続できないことがあるため、その場合はスマホでの確認
     （設定画面のバージョン表示・既存セーブの引き継ぎ）をユーザーに依頼する。

## セーブデータのルール

- **修正前に確認する箇所**
  - `AL.CONFIG`（`SAVE_VERSION`・`SAVE_KEY`・`BACKUP_KEY`・`GAME_VERSION`）
  - `AL.State`（`createDefault`・`MIGRATIONS`・`migrate`・`checkRequired`・`sanitize`・`parse`）
  - `AL.Save`（`write`・`read`・`exportText`）
- **影響の分類**
  - **A：影響なし** … 見た目・文言・演出・バランス数値など。セーブの項目や ID は変えない。
  - **B：項目追加** … 既存の項目・ID はそのままに、新しい項目を追加する。`sanitize` で既定値を補い、古いセーブも読めるようにする。
  - **C：構造変更・ID 変更** … 項目の移動・改名・削除、ID の変更など。**実装前にユーザーに相談する。**
- **保存キーを変更しない。** `abyssal_legends_save` と `abyssal_legends_save_backup` は固定。
  公開URLのドメイン（`rikuink000-collab.github.io`）を変えることも、既存のセーブが読めなくなるため避ける。
- **C の場合は、バージョン移行処理を追加する。**
  - `SAVE_VERSION` を1つ上げ、`State.MIGRATIONS[旧バージョン]` に変換関数を追加する。既存の移行処理は消さない。
  - 仲間・装備・セット・ダンジョン・実績・転生強化などの ID を削除・改名しない。`sanitize` は未知の ID を
    黙って捨てるため、プレイヤーのデータが消える。改名が必要なら移行処理で旧 ID を新 ID に置き換える。
  - `SAVE_VERSION` を上げた変更は `revert` で戻さない（旧コードは新形式を読めず、新規開始になる）。
    不具合は修正版を出して直す。
- **読み込めないセーブは退避してから扱う。**（`Save.read`・`Save.quarantine`）
  - 本体（またはバックアップ）が読み込めなければ、`<元のキー>_corrupt_<時刻>` に退避する。使用中なら `_<時刻>_<連番>` にし、
    既存の退避データは上書きしない。成功は「書き込み成功」かつ「読み戻した内容が一致」で判定する。
  - 退避を確認できなかったデータは「保護中」とし、そのキーへの保存・削除を止める（取り込み・転生・初期化も止める）。
    保護は退避の再試行に成功したときだけ解除する。この挙動を変えるときは `tests/save-recovery.test.mjs` も合わせて確認する。
- **導入（はじめての冒険）の進行は `state.guide` に保存する。**（`State.sanitizeGuide`・`AL.Guide`）
  - `guide` 項目のない既存セーブは、導入を終えた既存プレイヤー（`legacy`）として読み込み、導入や初回報酬を出さない。
  - 初回召喚・初回戦闘の報酬は `guide.rewards` のフラグで一度だけ付与する。この挙動を変えるときは `tests/guide.test.mjs` も合わせて確認する。
- **クエストの受け取り記録は `state.quests` に保存する。**（`State.sanitizeQuests`・`AL.Quests`）
  - 進捗は既存の記録（`state.stats` など）から計算し、保存するのは受け取り済みの ID とデイリーの開始時点の記録だけ。
  - 報酬の付与と受け取り済みの記録は同じ処理で行う。クエストの ID は削除・改名しない（受け取り記録が消え、再び受け取れてしまう）。
  - デイリーはショップと同じ端末の日付（`U.dateKey`）で切り替え、時刻を過去に戻しても戻さない。変えるときは `tests/quests.test.mjs` も確認する。
- **実績画面は、実績（`state.achievements.claimed`）と実績クエスト（`state.quests.ach.claimed`）を一緒に表示する。**（`AL.Achievements.entries`・`claimEntry`）
  - 受取記録は統合せず、それぞれ別の保存先のまま。受け取りは既存の処理（`Achievements.claim`・`Quests.claim`）を呼ぶだけにし、同じ報酬を受け取れる新しい経路を作らない。
  - 分類（メイン・育成・累計）は記録の種類（stat）で決める（`Achievements.CATEGORIES`）。変えるときは `tests/achievements.test.mjs` も確認する。

## リポジトリと公開のルール

- **`main` に直接プッシュしない。** 変更は必ず作業ブランチ → PR を通す。
- **ブランチ保護を回避しない。** ルールセットの無効化・変更、管理者権限での強制マージ、`main` への強制プッシュ、
  必須チェックを通さないマージはしない。保護が原因で進めない場合は、ユーザーに報告する。
- **実データや個人情報を、コミット・PR の説明・コメントに含めない。** 実際のセーブ書き出しファイル、
  そこから抽出・加工したデータ、メールアドレスなどの個人情報が対象。リポジトリは公開されている。
- テストのためだけにゲーム本体（`index.html`）を変更しない。
- **公開サイトに出すのはゲーム本体と README、共有用のリンクカード画像 `og-image.png`（1200×630。`index.html` の OGP・X Card が参照）だけにする。** Pages は `main` を Jekyll で公開するため、
  開発・テスト用のファイルを追加したら `_config.yml` の `exclude` にも追加する
  （`.` や `_` で始まるファイル・ディレクトリはもともと公開されない）。`npm test` がこれを自動で確認する。

## 戦闘演出（pixelfx）のルール

- 戦闘画面の演出（通常ヒット・クリティカル・撃破・回復・報酬）は、外部ライブラリ pixelfx（https://github.com/patch-gg/pixelfx、MIT）を
  `index.html` の `js/gfx/pixelfx.js` 区画に内蔵して使う。ファイルは増やさない（ゲーム本体は `index.html` の1ファイルのまま）。
  - `js/gfx/pixelfx.js` は **手で編集しない**。`git clone --depth 1 https://github.com/patch-gg/pixelfx <場所> && (cd <場所> && npm ci)` のあと、
    `node third_party/pixelfx/build.mjs <場所>` でまとめ直す（`--check` で今の区画と同じかだけを確かめられる）。使うエフェクトは
    `third_party/pixelfx/entry.js` に書く。ライセンス（`third_party/pixelfx/LICENSE`・`NOTICE.md`）は、区画の直前の表示とあわせて残す。
    `third_party/` は `_config.yml` の `exclude` に入れ、公開しない。ゲーム内（その他画面）と README にクレジットを入れる。
  - 使わないもの：標準の人形（actor）を使うエフェクト（`hit-flash`・`dissolve-burn`・`holy/heal` など）、`act.js`、Patch Pixel フォント。
  - pixelfx（外部）のコードを実行する前に、毎回りくさんに確認する。2026-11-01 の試用では、作業用フォルダ内での `npm ci`（esbuild の導入）・まとめ・計測・撮影の実行を許可された。この許可は、そのときの試用だけのもの。
- 演出を出すのは `js/gfx/fx.js`（`AL.Fx`）だけ。**描画だけを担当し、戦闘の計算・セーブ・ゲームの乱数（`U.rng`）には触れない。**
  同時再生は3つまで（通常ヒットは2つまで）、優先度は ボス撃破 > クリティカル > 撃破 > 回復 > 報酬 > 通常ヒット。
  演出の品質「低」では使わない。pixelfx で例外が出たら、そのセッションだけ使わず、これまでの粒子表現に戻す（戦闘は止めない）。
  - 重い端末への自動調整（`AL.Fx.perf`）：端末名ではなく、戦闘中（停止中・品質「低」を除く）の実際のフレーム間隔で判定する。
    25ms 超のフレームが半分以上の区切り（60フレーム）が3回続いたら、そのセッション中は同時再生の上限を3→2（通常ヒットは2→1）に下げ、戻さない。
    250ms 超の間隔（タブの切り替えなど）は数えない。優先度は変えない。判定の基準を変えるときは `tests/pixelfx.test.mjs` も意図して更新する。
  合成・転送は、演出が使う範囲だけに絞っている（余白は `PAD_*`。pixelfx の `meta.size` は光の広がりを含まないため、実測で決めた）。
  エフェクトを足す・変えるときは、`tests/smoke.mjs` の「範囲を絞った描画が全画面の描画と一致する」テストも確認する。

## 不具合・ご意見の報告フォームのルール

- 「その他」画面の「サポート」タイル（PC では上部メニューの「サポート」）から開く、不具合・ご意見を送る独立した機能（1.10.1 で設定画面のパネルから移動）。通信と入力チェックは `AL.Report`（`js/core/report.js`）、画面は `js/ui/report.js`。
  **ゲームの状態（`AL.Game.state`）・セーブ・戦闘・乱数（`U.rng`）には触れない。** フォームを開く・閉じるだけでセーブは変わらない（`tests/report.test.mjs` がソースの参照を、`tests/smoke.mjs` がセーブの不変を確認する）。
  セーブへの影響は A（セーブの項目・保存キー・`SAVE_VERSION` は変えない）。
- 送るのは、入力内容とバージョン（`AL.CONFIG.GAME_VERSION`）・OS・ブラウザ情報だけ。**セーブデータ・所持品・進行状況は送らない**（項目を増やすときはユーザーに相談する）。
- 送信先は `AL.CONFIG.REPORT.ENDPOINT` の1か所だけ（ユーザーがデプロイした Google Apps Script のウェブアプリ URL。`https://script.google.com/macros/s/…/exec` 以外は送らない）。
  **仮の URL を入れない。** 変えてよいのは、ユーザーが自分の Google アカウントでデプロイした URL を教えてくれたときだけ。転送先の一時的な URL（`googleusercontent`・`user_content_key`）や `/dev` は使わない。
- 受付側は `gas/Code.gs`（Google Apps Script）。手順書は `gas/SETUP.md`。`gas/` は `_config.yml` の `exclude` に入れ、公開しない。ソースに URL・ID・キーを書かない。
  文字数の上限・種類・列構成はゲーム側と同じ値にする（`tests/report.test.mjs` が一致を確認する）。
- 入力内容は HTML として解釈しない（`esc()` と `value` で扱う）。スプレッドシートでは `= + - @` で始まる文字を無害化する。
- 本物の Google Apps Script・スプレッドシート・ブラウザからの送信（CORS）はテストできない。テストは架空の Google 環境と Playwright の偽の受付先で行っている。実環境の確認はユーザーに依頼する。

## ランキングのルール

- オンラインのランキング（v1。1.10.2 で通信の仕組み、画面は次の PR）。通信は `AL.Ranking`（`js/core/ranking.js`）。Firebase の匿名認証（Identity Toolkit）と Firestore を
  REST（fetch）で直接呼ぶ。**Firebase SDK は読み込まない**（外部スクリプトを増やさない）。サーバー側の検証は `firebase/firestore.rules` だけで行う（無料の Spark プランで Cloud Functions は使わない）。
  **ゲームの状態（`AL.Game.state`）・セーブ・戦闘・乱数（`U.rng`）には触れない。** 送信時に渡された state から値を読むだけ（`tests/ranking.test.mjs` がソースの参照を確認する）。
  セーブへの影響は A（セーブの項目・保存キー・`SAVE_VERSION` は変えない）。
- **ランキングで送信する項目は次の5つだけ**：表示名・通算の最高到達階層（`stats.maxFloorEver`）・ボスラッシュ最高撃破数（`stats.rushBest`）・転生回数（`rebirth.count`）・到達／更新の時刻（サーバー時刻）。
  Firestore の `leaderboard/{uid}` = `{ name, floor, floorAt, rush, rebirths, updatedAt, hidden }`（`hidden` は管理者がコンソールで立てる非表示フラグ）。項目を増やすときはユーザーに相談する。
  総戦力・獲得ゴールドは送らない（順位にも使わない）。転生回数は表示だけで、順位には使わない。
- **参加はオプトイン。** 利用者が「参加する」を押すまで一切通信しない（参加していなければ送信・順位の取得もしない）。
- **オンライン情報（匿名ログインの uid・リフレッシュトークン・表示名・前回送った値）は、セーブとは別のキー `abyssal_legends_online` に保存する。** セーブ本体・書き出しテキストには入れない
  （書き出しテキストを人に見せたときにログイン情報が漏れるため）。ID トークンは保存しない（メモリだけ）。
- 接続先は `AL.CONFIG.RANKING` の `API_KEY`・`PROJECT_ID` だけ（ユーザーが自分の Firebase プロジェクトで作ったウェブアプリの値。2026-11-20 にりくさんから受け取った `abyssal-legends` のもの）。**仮の値を入れない。** 変えてよいのは、ユーザーが新しい値を教えてくれたときだけ。 空のときはランキングを使えない（画面にも出さない）。
  Firebase の API キーは公開されてよい種類の値（権限はルールで制限する）だが、本物のプロジェクトにテストから接続しない。
- ルールの上限（表示名 1〜12 文字・階層 1〜100000・ボスラッシュ 0〜10000・転生回数 0〜100000・送信間隔 60 秒・伸び幅）は `AL.Ranking.LIMITS`・`AL.CONFIG.RANKING.COOLDOWN_SEC` と同じ値にする
  （`tests/ranking.test.mjs` が一致を確認する）。伸び幅の根拠はルールのコメントに書く。ルールを変えるときは `tests/ranking-rules.emu.mjs` も合わせて確認する。
- 表示名の文字数は Firestore のルール（`string.size()`）と同じく UTF-16 の単位で数える（絵文字は2文字）。HTML などで使う記号（山かっこ・アンパサンド・引用符・バッククォート・バックスラッシュ）は使えない。表示するときも `esc()` を通す。
- `firebase/`（ルール・インデックス・エミュレーターの設定）は `_config.yml` の `exclude` に入れ、公開しない。

## テスト

- `npm test`：`tests/smoke.mjs`（Playwright の Chromium、iPhone 13 相当の画面）と `tests/*.test.mjs`（Node.js）を実行する。
  - 起動・ロード画面の終了・全画面の表示・JavaScript エラーがないこと
  - 保存キーと移行処理の整合性
  - セーブの保存・再読み込み・書き出しファイルの読み込み
  - 合成セーブ `tests/fixtures/save-v3.json` の重要データ（通貨・階層・仲間・装備・転生・実績など）が読み込み後に失われないこと
  - GitHub Pages の公開対象が `index.html`・`README.md`・`og-image.png` だけであること（`_config.yml` の `exclude` を検証）
  - リポジトリ内のテスト用セーブが合成データ（`_fixture: "synthetic..."`）であり、
    実際のセーブ書き出しファイルが含まれていないこと
- 変更に合わせて追加するテスト
  - B・C：変更前の形式のセーブを読み込み、データが失われないことを確かめるテストを追加する。
  - 見た目の変更：スクリーンショット（`test-results/`）を確認する。
- `tests/guide.test.mjs`：導入の新規開始・途中再開・既存セーブ・初回報酬の重複防止・機能の段階的な解放を確認する。
  画面の流れ（タイトル → 初回召喚 → はじめての戦い → 育成の案内）は `tests/smoke.mjs` で確認する。
  導入と関係のない画面のテストは、`startAsVeteran`（導入を終えた状態で開始）を使う。
- `tests/quests.test.mjs`：クエストの進捗・魂晶の量・二重受け取りの防止（再読み込みを含む）・日付の変更・既存セーブとの互換性を確認する。
  クエスト画面の操作は `tests/smoke.mjs` で確認する。
- `tests/achievements.test.mjs`：実績画面の項目（実績32件・実績クエスト11件）と分類、既存の受取記録の反映、一度だけ受け取れること（再読み込みを含む）を確認する。
  実績画面の操作（受け取り直後の保存・表示の更新・バッジ）は `tests/smoke.mjs` で確認する。
- `tests/balance.test.mjs`：仲間のレア度別の基礎倍率・成長率・レベル上限（★3 Lv40・★4 Lv50・★5 Lv60、限界突破1回ごとに +10）、
  能力値の計算式、レベルアップと経験値の消費、スキルの待機時間と弱体の反映、既存セーブのレベル・限界突破の維持を確認する。
  仲間の詳細画面の上限表示・レベルアップは `tests/smoke.mjs` で確認する。`AL.CONFIG.HERO` を変えるときは、このテストも意図して更新する。
- `tests/equip-bulk.test.mjs`：装備の一括売却（通常・セット装備。装備中・ロック中は売らない）・装備中を一括ロック・未装備を一括ロック解除の、
  内訳（`Inv.bulkSellPreview`・`Inv.lockEquippedPreview`・`Inv.unlockFreePreview`）と実行時の確かめ直し、二重実行・対象0件の扱いを確認する。
  装備中の判定は編成に関係なく所持しているすべての仲間で行う。確認ダイアログ・キャンセル・装備タップで強化画面を開く操作は `tests/smoke.mjs` で確認する。
- 戦闘画面のUI（1.10.0）は `tests/smoke.mjs` の「戦闘画面のUI改善」で確認する：総戦力が内部の計算（`Stats.partyPower`）と一致して大きく欠けずに出ること（360・390・430px・PC）、
  内訳・増減の表示、味方のHPは下部のカードだけ（頭上は敵だけ）・戦闘不能の表示・カードとキャラクターの選択の対応、
  自動進行は「階層の操作」で切り替え OFF のときだけ「周回中」「次の階層へ」を出すこと、戦闘速度の1ボタン（設定画面と同じ `settings.speed`）、空の通知バッジを出さないこと。
- `tests/ogp.test.mjs`：共有時のリンクカード（OGP・X Card）のメタタグが1つずつあること、画像 `og-image.png`（1200×630）の URL・存在・公開対象を確認する。
  X での実際の表示はテストでは確かめられないため、公開後に確認する。
- `tests/report.test.mjs`：報告機能の入力チェック（必須・文字数の境界・メール形式・空白だけ）、送信先の検証、送る項目、通信の成功・各種の失敗、二重送信の防止と再送、
  GAS の `doPost`（架空の SpreadsheetApp・LockService などの上）の保存・検証・報告ID・再送・頻度制限・数式の無害化・ロック、GAS とゲームの設定の一致を確認する。
  フォームの操作（開閉・セーブ不変・360px／390px・確認 → 送信中 → 完了・失敗時の入力保持・HTML を解釈しないこと）は `tests/smoke.mjs` の「報告」で確認する。
- `tests/pixelfx.test.mjs`：pixelfx の区画のライセンス表示・形（`import`・`export` や外部通信がないこと、大きさの予算）、区画の順序、
  アダプターの優先度・同時再生の上限、重い端末への自動調整の判定（境界の値・戻さないこと・数えない場面・上限2での押しのけ）、`third_party/` の公開除外、クレジットを確認する。演出が実際に出ること・同時再生・描画の一致・
  例外時の退避・実際の戦闘での動作は `tests/smoke.mjs`（「戦闘演出（pixelfx）」）で確認する。見た目は `test-results/phone-fx-*.png` を目で確認する。
- `tests/ranking.test.mjs`：ランキングの通信（偽の Firebase）。未設定・未参加では通信しないこと、表示名の検証、送る項目（7つ）とサーバー時刻、別キーへの保存、送信間隔・変化なし・値を下げないこと、
  オフライン、トークンの取り直し、失敗の区別、取得のキャッシュと順位、自分の順位、削除、セーブ・書き出しへの影響がないこと、ルールとの上限の一致を確認する。
  画面からの操作とセーブの不変は `tests/smoke.mjs` の「ランキング（偽の Firebase）」で確認する（`googleapis.com` への通信はすべて偽の応答で受ける）。
- `npm run test:rules`（`tests/ranking-rules.emu.mjs`）：Firebase エミュレーター（認証・Firestore。`firebase-tools`、Java 21 以上が必要）の上で、`AL.Ranking` の参加〜削除と、ルールの6項目
  （本人だけ・範囲・増える方向だけ・60秒・伸び幅・hidden）を確認する。プロジェクト ID は `demo-` で始まるエミュレーター専用の値で、本物の Firebase には接続しない。GitHub Actions の `test` でも実行する。
- `tests/save-recovery.test.mjs`：架空の localStorage（テストごとに新しく作り、書き込み失敗などを仕込める）で、
  読み込み失敗時の復元、退避キーの衝突、退避の失敗と保護状態、バックアップの扱いを確認する。
  `tests/load-core.mjs` が index.html のゲームロジックを Node.js に読み込む（index.html は変更しない）。
- セーブのテストは、テストごとに新しいブラウザコンテキストと 127.0.0.1 の一時サーバー、または架空の localStorage で行うため、
  実際に遊んでいるセーブには触れない。
- Claude Code のクラウド環境では Chromium が `/opt/pw-browsers` に用意されているため、`npx playwright install` は不要。

### テスト用セーブデータ

- **リポジトリに置くテスト用セーブは合成データだけにする。** 実データ由来のデータ（書き出しファイルそのもの、
  そこから抽出・加工したもの）は、`tests/fixtures/` を含めリポジトリのどこにも置かず、コミットしない。
- `tests/fixtures/save-v3.json` はゲームのコード（`AL.State`・`AL.Inv`・`AL.Heroes`）で作った合成データ。
  作り直すときも合成データで作り、`_fixture` を `synthetic` で始める。実データで差し替えない。
- **実データでの確認は手元でだけ行う。**
  1. `node tests/extract-fixture.mjs <書き出しファイル>` で、最小限のデータを `private/save-v3.min.json` に抽出する
     （`private/` は `.gitignore` 済み。`tests/fixtures/` への出力はスクリプトが拒否する）。
  2. `AL_SAVE_FILE=private/save-v3.min.json npm test` で検証する。
     抽出せずに `AL_SAVE_FILE=<書き出しファイル> npm test` で、書き出しファイルをそのまま渡してもよい。
