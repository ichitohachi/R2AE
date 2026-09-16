# Windows版の更新手順（2026-09-15）

今回の修正を含むMac/Windows共通版です。OS別の古いLua/JSXと混ぜず、送信側と受信側をセットで更新してください。

## 反映内容

- 現在のタイムライン設定を優先し、fps・解像度・DF/NDF・開始TCを転送。
- `timelineInterlaceProcessing` でインターレースを判定。59.94iは29.97fps、50iは25fpsのコンポへ、配置・尺・開始位置も同時変換して実時間を維持。59.94pは半減しません。
- Transformグループ経由でScale・Position・Anchor・Rotation・Opacityを適用。
- 同素材・配置・トリム・速度が一致する付随音声を動画レイヤーへ統合。タイミングの違う音声は独立配置。
- cumuloworksさんのfps混在時の補正を維持・拡張。
- 起動中のAfterFX.exeを検出して受信JSXを実行。スペース入りのJSXパスを引用。

## ファイルの配置

1. 既存の同名ファイルを別フォルダへバックアップします。
2. エクスプローラーのアドレス欄に次のパスを貼り付け、`r2ae.lua` と `r2ae_debug.lua` を上書きします。フォルダがなければ作成してください。

```text
%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility
```

3. 同様に次のフォルダへ `r2ae_receive.jsx` を上書きします。

```text
%USERPROFILE%\Documents\ae_bridge
```

この版の送信先は上記の固定パスです。OneDriveに移動した「ドキュメント」フォルダへ独自に置き換えず、エクスプローラーのアドレス欄に上記をそのまま入力してください。

4. Resolveを再起動し、After Effectsを起動しておきます。
5. AEの「スクリプトによるファイルへの書き込みとネットワークへのアクセスを許可」を有効にします（すでに有効なら変更不要）。
6. Resolveで短いIN/OUTを指定し、Workspace → Scripts → Utility → r2ae（環境によってはScripts直下）を実行します。

毎回新しいコンポを作ります。以前のコンポは更新されません。自動実行に失敗した場合は、AEの「ファイル → スクリプト → スクリプトファイルを実行」から、上の配置先の `r2ae_receive.jsx` を実行できます。

## 検証状況

共通送信側16件、Windows送信分岐5件、受信側13件、計34件のモックテストに合格しています。Windowsのパス引用、AE未起動時の分岐、終了コード判定、連番とTransformを確認しました。これらはWindowsの実シェルやAEを動かしたテストではありません。

Windows実機での転送は未検証です。まず短い区間で、fps・DF・開始TC・Duration・変形・音声を確認してください。素材fps混在、フィールド処理の見え方、速度推定、チャンネル割当の制約は `REVIEW.ja.md` を参照してください。AEのインターレース出力はレンダー設定で別途指定します。

## GitHubへ反映する場合

別途の `R2AE-reviewed.zip` に共通ソース・README・レビュー・テストが入っています。Windows専用ZIPの3スクリプトも同じ内容です。共通ソースをリポジトリへ反映し、GitHubへのコミット・pushは利用者側で行ってください。
