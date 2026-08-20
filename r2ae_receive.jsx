// r2ae_receive.jsx  (R2AE: Resolve to After Effects ブリッジ 受信側)
// Resolveから渡されたJSONを読んで1つのコンプにレイヤーを並べる
// 対応OS: macOS / Windows（ExtendScriptのFile/Folderは両OS共通の書き方でOK）
//
// 置き場所:
//   macOS   : ~/Documents/ae_bridge/r2ae_receive.jsx
//   Windows : %USERPROFILE%\Documents\ae_bridge\r2ae_receive.jsx
// 事前に AE 環境設定 > スクリプトとエクスプレッション >
//   「スクリプトによるファイルへの書き込みとネットワークへのアクセスを許可」をON

(function resolveToAE() {
    var JSON_PATH = Folder("~/Documents/ae_bridge").fsName + "/r2ae.json";

    function readJSON(path) {
        var f = new File(path);
        if (!f.exists) {
            alert("JSONが見つかりません:\n" + path);
            return null;
        }
        f.encoding = "UTF-8";
        f.open("r");
        var txt = f.read();
        f.close();
        try {
            return eval("(" + txt + ")");
        } catch (e) {
            alert("JSONの解析に失敗しました: " + e.toString());
            return null;
        }
    }

    // 同じパスのフッテージが既にあれば再利用
    function findExistingFootage(path) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FootageItem && it.mainSource instanceof FileSource) {
                if (it.mainSource.file && it.mainSource.file.fsName === path) {
                    return it;
                }
            }
        }
        return null;
    }

    function getOrCreateFolder(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FolderItem && it.name === name) return it;
        }
        return app.project.items.addFolder(name);
    }

    // Resolveの入力スケーリング係数を求める
    // Resolveは素材をタイムライン解像度に合わせてから Zoom を掛けるため、
    // AE側では fit * Zoom を Scale% として与える
    function getFitFactor(mode, srcW, srcH, compW, compH) {
        if (!srcW || !srcH) return { x: 1, y: 1 };
        var rx = compW / srcW;
        var ry = compH / srcH;
        switch (mode) {
            case "fill":    // 最短辺をマッチ（切り抜き）
                var f = Math.max(rx, ry);
                return { x: f, y: f };
            case "stretch": // 引き伸ばし
                return { x: rx, y: ry };
            case "none":    // 原寸
                return { x: 1, y: 1 };
            case "fit":     // 最長辺をマッチ（黒帯挿入）
            default:
                var g = Math.min(rx, ry);
                return { x: g, y: g };
        }
    }

    function applyTransform(layer, c, d, footage) {
        var t = c.transform;
        if (!t) return;

        var compW = d.width || 1920;
        var compH = d.height || 1080;
        var srcW = c.src_w || footage.width;
        var srcH = c.src_h || footage.height;

        var fit = getFitFactor(d.input_scaling, srcW, srcH, compW, compH);

        var sx = fit.x * (t.zoom_x != null ? t.zoom_x : 1) * 100;
        var sy = fit.y * (t.zoom_y != null ? t.zoom_y : 1) * 100;
        if (t.flip_x) sx = -sx;
        if (t.flip_y) sy = -sy;

        try {
            layer.property("Scale").setValue([sx, sy]);
        } catch (e) {}

        // Resolveはアンカーを「ピボット」として扱う。変換モデルは
        //   画面位置 = (素材座標 - ピボット) * 実効拡大率 + コンプ中心 + Pan + アンカー値
        // よってAEでは アンカー と ポジション の両方を動かす必要がある。
        //   ピボット(素材px) = 素材中心 + アンカー値 / フィット係数
        //   ポジション       = コンプ中心 + Pan + アンカー値
        var ax = t.anchor_x || 0;
        var ay = t.anchor_y || 0;

        try {
            layer.property("Anchor Point").setValue([
                srcW / 2 + (fit.x !== 0 ? ax / fit.x : 0),
                srcH / 2 - (fit.y !== 0 ? ay / fit.y : 0)  // ResolveのYは上が正
            ]);
        } catch (e) {}

        try {
            layer.property("Position").setValue([
                compW / 2 + (t.pan || 0) + ax,
                compH / 2 - (t.tilt || 0) - ay
            ]);
        } catch (e) {}

        try {
            layer.property("Rotation").setValue(t.rotation || 0);
        } catch (e) {}

        try {
            if (t.opacity != null && t.opacity !== 100) {
                layer.property("Opacity").setValue(t.opacity);
            }
        } catch (e) {}
    }

    // レイヤーの配置。リタイムがある場合はタイムリマップで再現する。
    // 失敗した場合は等速配置にフォールバックする。
    // 戻り値: 状態を表す文字列（診断用）
    function placeLayer(layer, c, fps, footage) {
        var offsetSec = c.offset / fps;
        var durSec = c.duration / fps;
        var inSec = c.source_in / fps;
        var speed = (c.speed != null) ? c.speed : 1;

        function placeNormal() {
            layer.startTime = offsetSec - inSec;
            layer.inPoint = offsetSec;
            layer.outPoint = offsetSec + durSec;
        }

        if (Math.abs(speed - 1) < 0.0001) {
            placeNormal();
            return "等速";
        }

        try {
            var t1 = offsetSec;
            var t2 = offsetSec + durSec;
            if (t2 - t1 < 1e-9) throw new Error("尺が0です");

            // タイムリマップ有効化でイン/アウトがリセットされるため先に行う
            layer.startTime = 0;
            layer.timeRemapEnabled = true;

            var tr = layer.property("Time Remap");
            if (!tr) throw new Error("Time Remapプロパティが取得できません");

            // 先に必要なキーを打つ。全キーを削除すると
            // タイムリマップ自体が無効化されプロパティが隠れてしまう
            // タイムリマップの値は素材の尺を超えられないためクランプする
            var maxSrc = null;
            try { maxSrc = footage.duration; } catch (eD) {}

            var startVal = inSec;
            var endVal = inSec + durSec * speed;
            var clamped = false;

            if (maxSrc != null && maxSrc > 0) {
                if (startVal < 0) { startVal = 0; clamped = true; }
                if (startVal > maxSrc) { startVal = maxSrc; clamped = true; }
                if (endVal < 0) { endVal = 0; clamped = true; }
                if (endVal > maxSrc) { endVal = maxSrc; clamped = true; }
            }

            tr.setValueAtTime(t1, startVal);
            tr.setValueAtTime(t2, endVal);

            // 有効化時に自動生成された不要なキーを後から削除する
            for (var k = tr.numKeys; k >= 1; k--) {
                if (tr.numKeys <= 2) break;
                var kt = tr.keyTime(k);
                if (Math.abs(kt - t1) > 1e-6 && Math.abs(kt - t2) > 1e-6) {
                    tr.removeKey(k);
                }
            }

            for (var j = 1; j <= tr.numKeys; j++) {
                try {
                    tr.setInterpolationTypeAtKey(
                        j,
                        KeyframeInterpolationType.LINEAR,
                        KeyframeInterpolationType.LINEAR
                    );
                } catch (eK) {}
            }

            // キーを打った後にイン/アウトを確定させる
            layer.inPoint = t1;
            layer.outPoint = t2;

            return "速度 " + Math.round(speed * 1000) / 10 + "%"
                + (clamped ? "(素材尺で丸め)" : "");
        } catch (e) {
            // 失敗したらリマップを解除して等速配置に戻す
            try { layer.timeRemapEnabled = false; } catch (e2) {}
            placeNormal();
            return "速度適用失敗(" + e.toString() + ")";
        }
    }

    var d = readJSON(JSON_PATH);
    if (!d || !d.clips || d.clips.length === 0) {
        alert("送られてきたクリップがありません");
        return;
    }

    app.beginUndoGroup("Import from DaVinci Resolve");

    var failed = [];
    var retimed = [];

    try {
        if (!app.project) app.newProject();

        var fps = d.fps || 24;
        var compDur = d.duration / fps;
        if (compDur <= 0) compDur = 1 / fps;

        var footageFolder = getOrCreateFolder("Resolve Footage");

        var comp = app.project.items.addComp(
            d.comp_name || "Resolve_AE",
            d.width || 1920,
            d.height || 1080,
            1,
            compDur,
            fps
        );
        comp.parentFolder = getOrCreateFolder("Resolve Comps");

        // JSONは下のレイヤーから順に並んでいる（audio -> V1 -> V2...）
        // layers.add() は常に最前面に追加されるため、この順で追加すれば
        // 最終的にVの上位トラックが一番上に来る
        for (var i = 0; i < d.clips.length; i++) {
            var c = d.clips[i];
            var src = new File(c.path);

            if (!src.exists) {
                failed.push(c.name + " (ファイルなし)");
                continue;
            }

            try {
                var footage = findExistingFootage(src.fsName);
                if (!footage) {
                    var io = new ImportOptions(src);
                    if (c.is_sequence) {
                        // Resolveから渡されるパスは連番の先頭フレーム。
                        // Mac側の既存動作は維持。
                        io.sequence = true;

                        // Windowsでは連番認識を明示的に再設定する。
                        if ($.os.indexOf("Windows") >= 0) {
                            try {
                                var seqName = src.name;
                                if (/^.*?\d+\.[^.]+$/.test(seqName)) {
                                    io.sequence = true;
                                }
                            } catch (eSeq) {}
                        }
                    }
                    if (io.canImportAs(ImportAsType.FOOTAGE)) {
                        io.importAs = ImportAsType.FOOTAGE;
                    }
                    footage = app.project.importFile(io);
                    footage.parentFolder = footageFolder;

                    if (c.is_sequence) {
                        // 連番はデフォルトのフレームレート想定を持つため、
                        // タイムラインのfpsに合わせて明示的に上書きする
                        try {
                            footage.mainSource.conformFrameRate = fps;
                        } catch (eFps) {}
                    }
                }

                var layer = comp.layers.add(footage);

                var status = placeLayer(layer, c, fps, footage);
                if (status.indexOf("失敗") >= 0) {
                    failed.push(c.name + " " + status);
                } else if (status !== "等速") {
                    retimed.push(c.name + " -> " + status);
                }

                applyTransform(layer, c, d, footage);

                // Aトラック側を独立レイヤーにした場合、映像側の音声はオフにする
                if (c.mute_audio === true && layer.hasAudio) {
                    layer.audioEnabled = false;
                }

                if (c.kind === "audio") {
                    layer.name = "[A" + c.track + "] " + c.name;
                } else {
                    layer.name = "[V" + c.track + "] " + c.name;
                }
            } catch (e2) {
                failed.push(c.name + " (" + e2.toString() + ")");
            }
        }

        comp.openInViewer();

        if (failed.length > 0) {
            alert("一部のクリップを読み込めませんでした:\n" + failed.join("\n"));
        }

        if (retimed.length > 0) {
            alert("リタイムを適用しました:\n" + retimed.join("\n"));
        }
    } catch (e) {
        alert("エラー: " + e.toString() + "\n(line " + e.line + ")");
    }

    app.endUndoGroup();
})();
