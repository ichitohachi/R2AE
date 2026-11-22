# R2AE

> 送受信の2ファイルをセットで更新してください。過去の修正と検証記録は [REVIEW.ja.md](REVIEW.ja.md) を参照してください。

**[English README](README.md)**

DaVinci Resolve のタイムラインから After Effects へ、クリップの配置・スケール・位置・回転・アンカーポイント・速度・音声を再現した状態で送るブリッジスクリプトです。

Adobe Dynamic Link のような常時リンクではありません。実行するたびに現在のタイムライン状態を JSON に書き出し、After Effects 側で新しいコンポジションとして再構築する「使い切りの転送」です。転送後は Resolve と After Effects の間に依存関係は残らず、どちらを編集しても相手に影響しません。

**本ツールは時短のための補助スクリプトであり、EDL や AAF、XML のような正確性を保証するデータ交換フォーマットではありません。** スケールや位置、アンカーポイントなどの変換式は、公式仕様に基づくものではなく、Resolveのインスペクタ値とAfter Effects上の実際の見え方を突き合わせた実測ベースで導出しています。手作業の繰り返しを省くために作られたものであり、両ソフト間の完全かつ無損失な橋渡しを保証するものではありません。重要な用途で使う場合は、必ず元のタイムラインと結果を見比べて確認してください。

![デモ: ResolveのタイムラインをAfter Effectsに送る様子](demo/r2ae_demo.gif)

## できること

- Editページのタイムラインで選択した映像・音声クリップだけを送信。WAVなどの音声クリップ単独でも送信可能
- 複数トラック（映像・音声）を対象。トラック単位 / クリップ単位の有効・無効を反映
- 現在のタイムライン固有の解像度・fps・DF/NDF表示・入力スケーリングと、転送範囲の開始タイムコードをコンポへ渡す
- クリップごとの Zoom・Pan/Tilt・Rotation・Anchor Point・Flip・Opacity を Scale / Position / Rotation / Anchor Point / Opacity に変換
- macOSでは、FCPXMLに含まれる位置・ズーム・回転・アンカーポイント・不透明度のキーを、AEで編集可能なキーフレームとして作成
- 定速リタイム（速度変更）をタイムリマップで再現。フレームレート変換との誤検出を避ける判定つき
- 一致する付随音声は動画レイヤーへ統合。それ以外のAトラックを独立音声レイヤーとして転送（チャンネル割当は未対応）。重複統合は任意設定
- 一致するAクリップがあるVレイヤーだけ音声ONにし、削除・無効化した音声の復活を防ぐ
- 同一転送内ではパス・素材解釈が一致する素材を再利用。転送をまたいだ再利用は行わず、既存コンプの素材解釈を保護

## できないこと

- リアルタイムの同期（Dynamic Link のような常時リンクではありません）
- トランジション、スピードランプ（可変速）、Fusionやエフェクトのキーフレーム
- カラーグレーディング、Resolve 側エフェクト、クロップ、複合クリップ、Fusion クリップ、タイトル
- ピッチ / ヨー（3D方向の傾き）は投影モデルの違いにより非対応

## 動作環境

- DaVinci Resolve 21.0.4以降（Resolve内のLuaスクリプトを使用）
- Adobe After Effects（2024 以降推奨）
- macOS または Windows

検証は macOS + DaVinci Resolve + After Effects 2026 の組み合わせで行っています。

**OSによってAEへの送信方式が異なります。**

- **macOS**: AppleScript経由でAEに直接スクリプト実行を指示します。常駐や追加設定は不要で、`r2ae`を実行するだけで自動的に完結します。
- **Windows**: 起動中のAfter Effectsプロセスを検出し、`AfterFX.exe -r`で直接スクリプトを実行させます。**あらかじめAfter Effectsを起動しておく必要があります**（未起動の場合は自動起動せず、その旨がResolveのコンソールに表示されます。JSONは書き出し済みなので、後からAEを起動して再実行すれば送れます）。複数バージョンのAEがインストールされている場合、実際に**起動しているバージョン**にクリップが送られます。

Windowsの今回の更新手順は [WINDOWS.ja.md](WINDOWS.ja.md) を参照してください。

## インストール

### 1. r2ae_receive.jsx の配置

```
macOS   : ~/Documents/ae_bridge/r2ae_receive.jsx
Windows : %USERPROFILE%\Documents\ae_bridge\r2ae_receive.jsx
```

`ae_bridge` フォルダが無ければ作成してください。

### 2. r2ae.lua の配置

```
macOS   : ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/r2ae.lua
Windows : %APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\r2ae.lua
```

配置後、**DaVinci Resolve を完全に再起動**してください。スクリプトフォルダは起動時に一度だけ読み込まれます。

### 3. After Effects側の設定

環境設定 > スクリプトとエクスプレッション > 「スクリプトによるファイルへの書き込みとネットワークへのアクセスを許可」を ON にしてください。OFF のままだと JSON の読み込みでエラーになります。

### 4.（任意）r2ae_debug.lua

Resolve が返す値を確認したいときのための調査用スクリプトです。同じ Utility フォルダに置くとメニューに追加されます。動作に必須ではありません。

## 使い方

Windowsでは、先にAfter Effectsを起動してください。

1. ResolveのEditページで、タイムライン上の送りたい映像・音声クリップを選択する。
2. Workspace > Scripts > Utility > `r2ae` を実行する。After Effectsに新しいコンポが作成される。

コンポの開始タイムコードは、転送したクリップのうち最も早い位置です。クリップ間の空白、トラック順、編集済みのトリムを維持します。音声を送りたい場合は音声クリップも選択してください。選択が空の場合はコンポを作成しません。

Windowsで自動実行に失敗した場合は、AEのファイル > スクリプト > スクリプトファイルを実行から `r2ae_receive.jsx` を開くと、書き出し済みのJSONを取り込めます。

## 設定項目

`r2ae.lua` 冒頭の変数で挙動を変更できます。

| 変数 | 説明 |
|---|---|
| `AUDIO_MODE` | `"auto"`（既定。同素材・配置・トリム・速度の音声を動画レイヤーへ統合）/ `"separate"`（別レイヤー） |
| `DEDUPE_AUDIO` | `false`（既定）。`true` は同パス・同位置のAクリップを統合。L/R判定は行わないため音量やチャンネルが変わる可能性あり |
| `TIMELINE_FRAME_RATE_OVERRIDE` | 既定は `nil`。インターレースのAPI座標を実測した場合のみ、フレーム数/秒を指定 |
| `INPUT_SCALING` | `"auto"`（既定。タイムラインの「解像度が一致しないファイル」設定を使用）/ `"fit"` / `"fill"` / `"stretch"` / `"none"` |
| `ROTATION_SIGN` | `1` / `-1`（既定）— 回転方向の補正 |
| `SOURCE_ROTATION_BY_PATH` | 既定は空。AEで読み込んだ向きから追加で回す素材を、絶対パスと角度（時計回り `90`、反時計回り `-90`、半回転 `180`）で指定 |
| `ENABLE_SPEED` | `true`（既定）— 速度変更をタイムリマップに反映するか |
| `ENABLE_TRANSFORM_KEYFRAMES` | `true`（既定）— macOSで編集ページのTransformキーフレームを転送するか |
| `RESPECT_TRACK_ENABLE` | `true`（既定）— 無効化したトラックを除外するか |
| `RESPECT_CLIP_ENABLE` | `true`（既定）— 無効化したクリップ（`D`キー）を除外するか |

## 仕組み

1. `r2ae.lua` が Resolve Scripting API 経由でタイムラインを読み、対象クリップのパス・トリム位置・Transform 値・速度をまとめて JSON に書き出す
2. **macOS**: `osascript` で After Effects に `r2ae_receive.jsx` の実行を直接指示する
3. **Windows**: `Get-Process` で起動中の`AfterFX.exe`の実パスを取得し、`AfterFX.exe -r`で`r2ae_receive.jsx`の実行を直接指示する（After Effectsが起動している必要がある。うまくいかない場合は手動実行で後から取り込める）
4. `r2ae_receive.jsx` が JSON を読み込み、素材をインポートしてコンポジションを構築する

以降、両ソフト間の接続は残りません。

## Transform 変換について

Resolve のインスペクタ値（Zoom / Pan / Tilt / Anchor Point / Rotation）は、タイムライン解像度・素材解像度・プロジェクトのスケーリング設定が絡み合った座標系を持っています。特に Anchor Point は単純な位置ではなく「ピボット」として扱われており、値を動かすと画面上の表示位置も一緒に動きます。このツールでは実測に基づいてこの変換式を導出しています（詳しくは `r2ae.lua` 内のコメントを参照）。

映像レイヤーは開始が早いものからAEの下から上へ並びます。時間が重なる区間はResolveの上位映像トラックをAEでも上に置きます。

Resolveのクリップ属性にある「Image Orientation」は自動取得できません。必要な素材は `SOURCE_ROTATION_BY_PATH` で追加回転角を指定できます。向き補正のプリコンは回転後の素材解像度、入力スケーリングのプリコンは拡縮後の画像範囲に合わせて作ります。どちらも必要な場合は、この順でネストします。プリコン内にスケーリングによる透明な余白は追加せず、素材が持つアルファは維持します。メインコンプではコラップストランスフォームを有効にし、Resolveのインスペクタで設定した変形を反映します。非正方形ピクセルの素材・タイムラインと、AEが素材プリコンを作成できない場合は、メインのTransformで合成します。

macOSでは、Resolveが書き出した一時FCPXMLから選択クリップのキーフレームを抽出します。AEでの補間は直線です。FCPXMLに含まれるキーはトリムの前後も元の相対時刻に配置し、レイヤーの表示範囲はResolveのトリムに合わせます。同じ素材が同じ位置・尺で重なって区別できない場合や、FCPXMLでリタイムが付いているクリップは静的なTransformで送ります。

## fps・DF・インターレース

動画は素材のfpsを維持します。Resolveの素材fpsとカメラfpsが同じ1000/1001系で、AEが整数fpsとして読み込んだ場合は、素材解釈をカメラfpsに合わせます。画像連番にはResolveの素材fpsを設定します。それ以外でResolveとAEの素材fpsが異なる場合は、Time Remapで差を補正します。

DFはタイムコードの番号付けであり、フレームの削除や速度変更ではありません。コンポのDF/NDFは明示設定します。元動画は再エンコード・変更せず読み込み、素材のタイムコードはAEのインポータに委ねます。Resolveの素材Start TC/FPS文字列はコメントへ記録しますが、素材DF表示やResolveで変更したStart TCの完全な再設定を保証しません。

素材の `Field Dominance` が `Progressive` / `Upper Field First` / `Lower Field First`（Upper/Lowerも可）ならAEのフィールド分離へ反映し、不明ならAEの自動解釈を維持して通知します。AEのフィールド出力はレンダー設定で指定します。レンダーキューの作成やフィールド出力の自動設定は行いません。

インターレース設定は実機で確認した `timelineInterlaceProcessing` を使用します。有効かつAPIレートが49以上のタイムラインでは、APIのフィールドカウントを維持して素材IN・速度を計算した後、コンポfps・配置・尺・開始フレームを1/2に換算します。59.94iではコンポ29.97fps、50iでは25fpsとなり、実時間は変わりません。プログレッシブ59.94fpsは変換しません。設定取得不能時は確認メッセージを出します。今回の59.94i API値は実機取得済みですが、修正後のAE画面は未確認です。

## 既知の制約

- 素材 fps とタイムライン fps が異なる場合のコンフォームと、実際の速度変更の判定はヒューリスティックです。誤判定に気づいた場合は Issue で実測値（Resolve Console のログ）を添えて報告してください
- ピッチ / ヨーは Resolve と After Effects で投影モデルが異なるため、正確な再現ができず非対応としています
- 音量・パン・モノ/ステレオのチャンネル割当・Fairlight FX・ピッチ維持・サンプル単位の音声IN点は保証しません。L/R分割素材はAEで確認してください
- 非正方形ピクセルを含むTransform、カラー管理、Optical Flow等のフレーム補間、フリーズ/可変速、VFR動画の完全一致は保証しません
- Windowsの自動実行には、あらかじめAfter Effectsが起動している必要があります。未起動の場合は自動起動せず、コンソールにその旨が表示されます（JSONは書き出し済みなので、後からAEを起動して手動実行で取り込めます）

## ライセンス

MIT License. `LICENSE` を参照してください。

## 免責事項

本ツールは DaVinci Resolve および After Effects の公式ドキュメント記載のスクリプティング API のみを使用しています。両ソフトの内部実装や非公開 API には依存していませんが、将来のバージョンアップで API の挙動が変わった場合、動作しなくなる可能性があります。無保証で提供されます。重要なプロジェクトで使用する前に、必ずテスト環境で動作を確認してください。
