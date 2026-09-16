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

    // ExtendScriptはJSON.parseがない環境もある。evalせずJSON文法のみを読む。
    function parseJSON(text) {
        var pos = 0;
        function space() { while (/\s/.test(text.charAt(pos)) && pos < text.length) pos++; }
        function bad() { throw new Error("Invalid JSON at " + pos); }
        function str() {
            if (text.charAt(pos++) !== '"') bad();
            var result = "";
            while (pos < text.length) {
                var ch = text.charAt(pos++);
                if (ch === '"') return result;
                if (ch === "\\") {
                    ch = text.charAt(pos++);
                    var escapes = {'"':'"', "\\":"\\", "/":"/", b:"\b", f:"\f", n:"\n", r:"\r", t:"\t"};
                    if (ch === "u") {
                        var hex = text.substr(pos, 4);
                        if (!/^[0-9a-fA-F]{4}$/.test(hex)) bad();
                        result += String.fromCharCode(parseInt(hex, 16)); pos += 4;
                    } else if (escapes.hasOwnProperty(ch)) result += escapes[ch];
                    else bad();
                } else {
                    if (ch.charCodeAt(0) < 32) bad();
                    result += ch;
                }
            }
            bad();
        }
        function value(depth) {
            if (depth > 100) bad();
            space();
            var ch = text.charAt(pos), result, key;
            if (ch === '"') return str();
            if (ch === "{" || ch === "[") {
                pos++; var array = ch === "[", end = array ? "]" : "}";
                result = array ? [] : {};
                space();
                if (text.charAt(pos) === end) { pos++; return result; }
                while (true) {
                    space();
                    if (array) result.push(value(depth + 1));
                    else {
                        key = str(); space();
                        if (text.charAt(pos++) !== ":" || key === "__proto__" || key === "constructor") bad();
                        result[key] = value(depth + 1);
                    }
                    space(); ch = text.charAt(pos++);
                    if (ch === end) return result;
                    if (ch !== ",") bad();
                }
            }
            var token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.substring(pos));
            if (!token) bad();
            pos += token[0].length;
            if (token[0] === "true") return true;
            if (token[0] === "false") return false;
            if (token[0] === "null") return null;
            result = Number(token[0]);
            if (!isFinite(result)) bad();
            return result;
        }
        var result = value(0); space();
        if (pos !== text.length) bad();
        return result;
    }

    function readJSON(path) {
        var f = new File(path);
        if (!f.exists) {
            alert("JSONが見つかりません:\n" + path);
            return null;
        }
        f.encoding = "UTF-8";
        if (!f.open("r")) { alert("JSONを開けません: " + f.error); return null; }
        var txt = f.read();
        f.close();
        try {
            return parseJSON(txt);
        } catch (e) {
            alert("JSONの解析に失敗しました: " + e.toString());
            return null;
        }
    }

    // この転送内だけで再利用。既存コンプの手動解釈/プロキシに影響されない。
    var imported = {};
    function footageKey(path, c) {
        return path + "|" + (c.is_sequence ? c.src_fps : "movie") + "|" + c.src_field;
    }
    function fieldMode(value) {
        var v = String(value || "").toLowerCase();
        if (v === "progressive") return FieldSeparationType.OFF;
        if (v === "upper field first" || v === "upper") return FieldSeparationType.UPPER_FIELD_FIRST;
        if (v === "lower field first" || v === "lower") return FieldSeparationType.LOWER_FIELD_FIRST;
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
        // Match names must be resolved from their immediate parent group.
        var group = layer.property("ADBE Transform Group");
        if (!group) throw new Error("Transformグループを取得できません");
        function setTransform(matchName, value) {
            var prop = group.property(matchName);
            if (!prop) throw new Error("Transformプロパティを取得できません: " + matchName);
            try { prop.setValue(value); }
            catch (e) { throw new Error("Transform適用失敗 (" + matchName + "): " + e.toString()); }
        }

        var compW = d.width || 1920;
        var compH = d.height || 1080;
        var srcW = c.src_w || footage.width;
        var srcH = c.src_h || footage.height;

        var fit = getFitFactor(d.input_scaling, srcW, srcH, compW, compH);

        var sx = fit.x * (t.zoom_x != null ? t.zoom_x : 1) * 100;
        var sy = fit.y * (t.zoom_y != null ? t.zoom_y : 1) * 100;
        if (t.flip_x === true || t.flip_x === 1) sx = -sx;
        if (t.flip_y === true || t.flip_y === 1) sy = -sy;

        setTransform("ADBE Scale", [sx, sy]);

        // Resolveはアンカーを「ピボット」として扱う。変換モデルは
        //   画面位置 = (素材座標 - ピボット) * 実効拡大率 + コンプ中心 + Pan + アンカー値
        // よってAEでは アンカー と ポジション の両方を動かす必要がある。
        //   ピボット(素材px) = 素材中心 + アンカー値 / フィット係数
        //   ポジション       = コンプ中心 + Pan + アンカー値
        var ax = t.anchor_x || 0;
        var ay = t.anchor_y || 0;

        setTransform("ADBE Anchor Point", [
            srcW / 2 + (fit.x !== 0 ? ax / fit.x : 0),
            srcH / 2 - (fit.y !== 0 ? ay / fit.y : 0)  // ResolveのYは上が正
        ]);

        setTransform("ADBE Position", [
            compW / 2 + (t.pan || 0) + ax,
            compH / 2 - (t.tilt || 0) - ay
        ]);

        setTransform("ADBE Rotate Z", t.rotation || 0);

        if (t.opacity != null && t.opacity !== 100) {
            setTransform("ADBE Opacity", t.opacity);
        }
    }

    // レイヤーの配置。リタイムがある場合はタイムリマップで再現する。
    // 失敗したクリップは外側で除去し、誤った等速配置を残さない。
    // 戻り値: 状態を表す文字列（診断用）
    function placeLayer(layer, c, fps, footage) {
        var offsetSec = c.offset / fps;
        var durSec = c.duration / fps;
        // source_in は素材フレーム基準。動画はAEの読み込みfpsで秒へ換算し、
        // Resolveの素材解釈fpsとの差をレイヤー速度で再現する。
        var srcFps = (c.src_fps && c.src_fps > 0) ? c.src_fps : fps;
        // 動画は元のfpsのまま取り込む。Resolveの素材解釈変更はレイヤー速度で表す。
        var nativeFps = footage.hasVideo && !footage.mainSource.isStill ? footage.frameRate : srcFps;
        if (!(c.src_fps > 0)) srcFps = nativeFps;
        var inSec = c.source_in / nativeFps;
        var speed = ((c.speed != null) ? c.speed : 1) * srcFps / nativeFps;

        function placeNormal() {
            layer.startTime = offsetSec - inSec;
            layer.inPoint = offsetSec;
            layer.outPoint = offsetSec + durSec;
        }

        if (Math.abs(speed - 1) < 0.0001) {
            placeNormal();
            return "等速";
        }

        if (!footage.hasVideo && speed !== 0) {
            layer.stretch = 100 / speed;
            layer.startTime = offsetSec - inSec / speed;
            layer.inPoint = offsetSec;
            layer.outPoint = offsetSec + durSec;
            return "音声速度 " + speed * 100 + "%（ピッチ維持は未対応）";
        }
        try {
            var t1 = offsetSec;
            var t2 = offsetSec + durSec;
            if (t2 - t1 < 1e-9) throw new Error("尺が0です");

            // タイムリマップ有効化でイン/アウトがリセットされるため先に行う
            layer.startTime = 0;
            layer.timeRemapEnabled = true;

            var tr = layer.property("ADBE Time Remapping");
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
                if (startVal < 0 || startVal >= maxSrc) throw new Error("素材INが範囲外です");
                // 値だけのクランプは区間全体の速度を変える。キーの時刻も同時に補正。
                var bounded = Math.max(0, Math.min(maxSrc, endVal));
                if (bounded !== endVal) {
                    t2 = t1 + (bounded - startVal) / speed;
                    endVal = bounded;
                    if (t2 <= t1) throw new Error("リタイムの有効区間がありません");
                    clamped = true;
                }
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
            layer.outPoint = offsetSec + durSec;

            return "速度 " + Math.round(speed * 1000) / 10 + "%"
                + (clamped ? "(素材尺で丸め)" : "");
        } catch (e) {
            // 失敗を呼び出し元に返し、不完全なレイヤーを除去する
            try { layer.timeRemapEnabled = false; } catch (e2) {}
            throw new Error("速度適用失敗: " + e.toString());
        }
    }

    var d = readJSON(JSON_PATH);
    if (!d || !d.clips || d.clips.length === 0) {
        alert("送られてきたクリップがありません");
        return;
    }

    if (!(d.fps > 0) || !(d.width > 0) || !(d.height > 0) || !(d.duration > 0)) {
        alert("タイムライン設定または尺が不正です"); return;
    }
    app.beginUndoGroup("Import from DaVinci Resolve");

    var failed = [];
    var retimed = [];
    var notices = d.warnings || [];

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
            d.pixel_aspect || 1,
            compDur,
            fps
        );
        comp.parentFolder = getOrCreateFolder("Resolve Comps");
        if (typeof d.drop_frame === "boolean") comp.dropFrame = d.drop_frame;
        try {
            if (d.display_start_frame != null) comp.displayStartFrame = d.display_start_frame;
            else if (d.display_start_time != null) comp.displayStartTime = d.display_start_time;
        } catch (eTC) { notices.push("開始タイムコード設定失敗: " + eTC.toString()); }
        comp.comment = "R2AE / Resolve fps=" + (d.fps_raw || fps)
            + " / interlaced=" + d.interlaced + " / 元のINフレーム=" + d.display_start_frame;

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

            var layer = null;
            try {
                if (!(c.duration > 0) || !isFinite(c.offset) || !isFinite(c.source_in)) {
                    throw new Error("クリップの時間情報が不正です");
                }
                var cacheKey = footageKey(src.fsName, c);
                var footage = imported[cacheKey];
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
                        // Resolveでの素材fps
                        // に合わせて明示的に上書きする。source_in の秒換算と
                        // AE側のフッテージ解釈を同じfpsに揃えるため
                        if (!(c.src_fps > 0)) throw new Error("連番の素材fpsが取得できません");
                        footage.mainSource.conformFrameRate = c.src_fps;
                    }
                    if (footage.hasVideo && !footage.mainSource.isStill) {
                        var mode = fieldMode(c.src_field);
                        if (mode != null) footage.mainSource.fieldSeparationType = mode;
                        else notices.push(c.name + ": 素材フィールド順不明。AEの自動解釈を使用（要確認）");
                    }
                    footage.comment = "Resolve FPS=" + c.src_fps_raw + " / Start TC=" + c.src_start_tc
                        + " / Field=" + c.src_field;
                    imported[cacheKey] = footage;
                }

                layer = comp.layers.add(footage);

                if (footage.hasVideo && !footage.mainSource.isStill && c.src_fps > 0
                    && Math.abs(c.src_fps - footage.frameRate) > 0.01) {
                    notices.push(c.name + ": Resolveの素材解釈fps=" + c.src_fps
                        + " / AEの素材fps=" + footage.frameRate + "。差はレイヤー速度に反映（要確認）");
                }
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
                    layer.enabled = false; // 映像スイッチのみOFF。音声は別スイッチ。
                    if (layer.hasAudio) layer.audioEnabled = true;
                    layer.name = "[A" + c.track + "] " + c.name;
                } else {
                    layer.name = "[V" + c.track + "] " + c.name;
                }
            } catch (e2) {
                if (layer) { try { layer.remove(); } catch (ignore) {} }
                failed.push(c.name + " (" + e2.toString() + ")");
            }
        }

        comp.openInViewer();
        if (notices.length > 0) {
            comp.comment += "\n" + notices.join("\n");
            alert("転送時の確認事項（コンポのコメントにも保存）:\n" + notices.slice(0, 12).join("\n")
                + (notices.length > 12 ? "\nほか " + (notices.length - 12) + " 件" : ""));
        }

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
