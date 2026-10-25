# ABYSSAL LEGENDS 開発ルール

ダークファンタジー放置RPG。ゲーム本体は `index.html` の1ファイルのみ（CSS・JS・画像をすべて内包）で、
GitHub Pages が `main` ブランチから公開しています。`main` に入った変更はそのまま公開サイトに出ます。

## 公開までの流れ

1. 作業ブランチ（セッションで指定された `claude/...`）で修正する。
2. `npm ci` → `npm test` を実行し、結果を確認する。
3. 変更内容とテスト結果をユーザーに報告してから、`main` 向けの PR を作る。
4. GitHub Actions の `test` が成功していることを確認する。
5. ユーザーが「公開して」と指示したときだけ PR をマージする。指示がなければマージしない。

## ルール

- **`main` に直接プッシュしない。** 変更は必ず作業ブランチ → PR を通す。
- **修正前に既存コードとセーブ処理を確認する。** 特に次の箇所：
  - `AL.CONFIG`（`SAVE_VERSION`・`SAVE_KEY`・`BACKUP_KEY`）
  - `AL.State`（`createDefault`・`MIGRATIONS`・`migrate`・`checkRequired`・`sanitize`・`parse`）
  - `AL.Save`（`write`・`read`・`exportText`）
- **修正後は可能な範囲で自動テスト（`npm test`）を実行する。** 実行できなかった項目は、その旨を報告する。
- **セーブの保存キーを変更しない。** `abyssal_legends_save` と `abyssal_legends_save_backup` は固定。
  公開URLのドメイン（`rikuink000-collab.github.io`）を変えることも、既存のセーブが読めなくなるため避ける。
- **セーブ形式を変更する場合は、バージョン移行処理を追加する。**
  - `SAVE_VERSION` を1つ上げ、`State.MIGRATIONS[旧バージョン]` に変換関数を追加する。既存の移行処理は消さない。
  - 仲間・装備・セット・ダンジョン・実績・転生強化などの ID を削除・改名しない。`sanitize` は未知の ID を
    黙って捨てるため、プレイヤーのデータが消える。改名が必要なら移行処理で旧 ID を新 ID に置き換える。
  - `SAVE_VERSION` を上げた変更は `revert` で戻さない（旧コードは新形式を読めず、新規開始になる）。
    不具合は修正版を出して直す。
- **テスト結果と変更内容を報告してから PR を作成する。**
- テストのためだけにゲーム本体（`index.html`）を変更しない。
- **公開サイトに出すのはゲーム本体と README だけにする。** Pages は `main` を Jekyll で公開するため、
  開発・テスト用のファイルを追加したら `_config.yml` の `exclude` にも追加する
  （`.` や `_` で始まるファイル・ディレクトリはもともと公開されない）。

## テスト

- `npm test`：`tests/smoke.mjs` を実行する（Playwright の Chromium、iPhone 13 相当の画面）。
  - 起動・ロード画面の終了・全画面の表示・JavaScript エラーがないこと
  - 保存キーと移行処理の整合性
  - セーブの保存・再読み込み・書き出しファイルの読み込み
  - `tests/fixtures/save-v3.json` の重要データ（通貨・階層・仲間・装備・転生・実績など）が読み込み後に失われないこと
- セーブのテストは、テストごとに新しいブラウザコンテキストと 127.0.0.1 の一時サーバーで行うため、
  実際に遊んでいるセーブには触れない。
- 実プレイの書き出しファイルはコミットしない。テスト用データは次のどちらかで使う。
  - `node tests/extract-fixture.mjs <書き出しファイル>` で最小限のデータだけを `tests/fixtures/save-v3.json` に抽出する。
  - `AL_SAVE_FILE=<書き出しファイル> npm test` で、手元のファイルをそのまま検証に追加する。
- Claude Code のクラウド環境では Chromium が `/opt/pw-browsers` に用意されているため、`npx playwright install` は不要。
