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
    var sourcePrecomps = {};
    var sourcePrecompFolder = null;
    function cameraRateCorrection(c) {
        if (c.is_sequence || !(c.camera_fps > 0) || !(c.src_fps > 0)) return 0;
        var whole = Math.round(c.src_fps);
        // カメラの公称値とResolveの素材fpsが一致する1000/1001系だけを補正対象にする。
        if (whole >= 24 && Math.abs(c.src_fps - whole * 1000 / 1001) < 0.0001
            && Math.abs(c.camera_fps - c.src_fps) < 0.0001) return whole;
        return 0;
    }
    function footageKey(path, c) {
        var rate = c.is_sequence || cameraRateCorrection(c) ? c.src_fps : "auto";
        return path + "|" + !!c.is_sequence + "|" + rate + "|" + c.src_field;
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

    function layerImportOrder(clips) {
        var audio = [];
        var video = [];
        for (var i = 0; i < clips.length; i++) {
            if (clips[i].kind === "audio") audio.push(clips[i]);
            else video.push({ clip: clips[i], index: i, blocked: 0, above: [] });
        }
        video.sort(function (a, b) {
            return a.clip.offset - b.clip.offset || a.clip.track - b.clip.track || a.index - b.index;
        });
        for (var first = 0; first < video.length; first++) {
            var a = video[first];
            for (var next = first + 1; next < video.length; next++) {
                var b = video[next];
                if (b.clip.offset >= a.clip.offset + a.clip.duration) break;
                var trackDifference = a.clip.track - b.clip.track;
                if (!(b.clip.duration > 0) || !trackDifference) continue;
                var upper = trackDifference > 0 ? a : b;
                var lower = upper === a ? b : a;
                lower.above.push(upper);
                upper.blocked++;
            }
        }
        // layers.add()は先頭に追加する。重なる映像は下位トラックを先に追加する。
        var bottomFirst = [];
        while (bottomFirst.length < video.length) {
            for (var n = 0; n < video.length; n++) {
                var ready = video[n];
                if (ready.blocked !== 0) continue;
                bottomFirst.push(ready.clip);
                ready.blocked = -1;
                for (var j = 0; j < ready.above.length; j++) ready.above[j].blocked--;
                break;
            }
        }
        return audio.concat(bottomFirst);
    }

    // クリップ属性を反映した素材寸法から、タイムラインへの入力スケーリングを求める。
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

    function sourceGeometry(c, d, footage) {
        var rotation = c.source_rotation || 0;
        var quarterTurn = rotation === 90 || rotation === -90;
        var width = footage.width || c.src_w;
        var height = footage.height || c.src_h;
        var orientedWidth = quarterTurn ? height : width;
        var orientedHeight = quarterTurn ? width : height;
        return {
            width: width, height: height, rotation: rotation, quarterTurn: quarterTurn,
            orientedWidth: orientedWidth, orientedHeight: orientedHeight,
            fit: getFitFactor(d.input_scaling, orientedWidth, orientedHeight, d.width, d.height)
        };
    }

    function getSourcePrecomp(footage, c, d, geometry, notices) {
        var fit = geometry.fit;
        var needsScaling = fit.x !== 1 || fit.y !== 1;
        if (!geometry.rotation && !needsScaling) return null;
        if ((footage.pixelAspect || 1) !== 1 || (d.pixel_aspect || 1) !== 1) {
            notices.push(c.name + ": 非正方形ピクセルのため、入力スケーリングはメインのTransformで再現");
            return null;
        }

        var still = footage.mainSource.isStill;
        var sourceFps = still ? d.fps : footage.frameRate;
        var duration = still
            ? Math.max(d.duration / d.fps, c.source_in / (c.src_fps || d.fps) + c.duration / d.fps)
            : footage.duration;
        var key = [footage.id, geometry.rotation, fit.x, fit.y, duration].join("|");
        if (sourcePrecomps[key]) return sourcePrecomps[key];

        function addStage(source, suffix, width, height, scale, rotation, collapse) {
            var stage = app.project.items.addComp(footage.name + suffix, width, height, 1, duration, sourceFps);
            try {
                if (stage.duration + stage.frameDuration / 2 < duration) {
                    throw new Error("AEのコンポの尺の上限を超えています");
                }
                stage.preserveNestedFrameRate = !still;
                var mediaLayer = stage.layers.add(source);
                mediaLayer.startTime = 0;
                mediaLayer.inPoint = 0;
                mediaLayer.outPoint = Math.min(stage.duration, duration);
                if (collapse) mediaLayer.collapseTransformation = true;
                var group = mediaLayer.property("ADBE Transform Group");
                group.property("ADBE Anchor Point").setValue([source.width / 2, source.height / 2]);
                group.property("ADBE Position").setValue([stage.width / 2, stage.height / 2]);
                group.property("ADBE Scale").setValue(scale);
                group.property("ADBE Rotate Z").setValue(rotation);
                stage.parentFolder = sourcePrecompFolder;
                return stage;
            } catch (e) {
                stage.remove();
                throw e;
            }
        }

        var oriented = null;
        try {
            if (!sourcePrecompFolder) sourcePrecompFolder = getOrCreateFolder("Resolve Source Precomps");
            if (geometry.rotation) {
                oriented = addStage(footage, " - Orientation", geometry.orientedWidth,
                    geometry.orientedHeight, [100, 100], geometry.rotation, false);
            }
            var precomp = oriented;
            if (needsScaling) {
                // ピクセルの端数は内側へ丸め、コラップスで元の倍率と枠外の画素を保つ。
                var width = Math.floor(geometry.orientedWidth * fit.x + 1e-7);
                var height = Math.floor(geometry.orientedHeight * fit.y + 1e-7);
                precomp = addStage(oriented || footage, " - Input Scaling", width, height,
                    [fit.x * 100, fit.y * 100], 0, !!oriented);
            }
            sourcePrecomps[key] = precomp;
            return precomp;
        } catch (e) {
            if (oriented) oriented.remove();
            notices.push(c.name + ": 素材プリコンを作成できないため、メインのTransformで再現: " + e.toString());
            return null;
        }
    }

    // 曲線ごとに異なるキー時刻を持てる。アンカーと位置を合成するときにも使う。
    function sampleKeys(keys, time, defaultValue) {
        if (!keys || !keys.length) return defaultValue;
        if (time <= keys[0][0]) return keys[0].slice(1);
        var left = 0;
        var right = keys.length - 1;
        if (time >= keys[right][0]) return keys[right].slice(1);
        while (right - left > 1) {
            var middle = Math.floor((left + right) / 2);
            if (keys[middle][0] <= time) left = middle;
            else right = middle;
        }
        var from = keys[left];
        var to = keys[right];
        var fraction = (time - from[0]) / (to[0] - from[0]);
        var values = [];
        for (var i = 1; i < from.length; i++) {
            values.push(from[i] + fraction * (to[i] - from[i]));
        }
        return values;
    }

    function applyTransform(layer, c, d, geometry, precomp, notices) {
        var t = c.transform;
        var orientation = precomp ? 0 : geometry.rotation;
        var quarterTurn = !precomp && geometry.quarterTurn;
        // Match names must be resolved from their immediate parent group.
        var group = layer.property("ADBE Transform Group");
        if (!group) throw new Error("Transformグループを取得できません");
        var animation = c.transform_keys || {};
        var offset = c.offset / d.fps;

        function setTransform(matchName, curves, sample) {
            var prop = group.property(matchName);
            if (!prop) throw new Error("Transformプロパティを取得できません: " + matchName);
            var times = [];
            for (var i = 0; i < curves.length; i++) {
                var keys = curves[i];
                if (!keys) continue;
                for (var j = 0; j < keys.length; j++) {
                    // 表示範囲はレイヤーのIN/OUTで制御し、キーの元時刻を保つ。
                    times.push(keys[j][0]);
                }
            }
            if (!times.length) {
                prop.setValue(sample(0));
                return;
            }

            times.sort(function (a, b) { return a - b; });
            try {
                for (var k = 0; k < times.length; k++) {
                    if (k === 0 || times[k] - times[k - 1] > 1e-7) {
                        prop.setValueAtTime(offset + times[k], sample(times[k]));
                    }
                }
            } catch (e) {
                // 変形キーだけを戻して静的な変形でレイヤーを残す。
                for (var j = prop.numKeys; j >= 1; j--) prop.removeKey(j);
                prop.setValue(sample(0));
                notices.push(c.name + ": キーフレーム適用失敗 (" + matchName + "): " + e.toString());
                return;
            }
            try {
                for (var key = 1; key <= prop.numKeys; key++) {
                    prop.setInterpolationTypeAtKey(key, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
                    if (prop.isSpatial) {
                        prop.setSpatialAutoBezierAtKey(key, false);
                        prop.setSpatialContinuousAtKey(key, false);
                        var zeroTangent = prop.keyInSpatialTangent(key);
                        for (var axis = 0; axis < zeroTangent.length; axis++) zeroTangent[axis] = 0;
                        prop.setSpatialTangentsAtKey(key, zeroTangent, zeroTangent);
                    }
                }
            } catch (e) {
                notices.push(c.name + ": キーフレームの補間設定失敗 (" + matchName + "): " + e.toString());
            }
        }

        var compW = d.width || 1920;
        var compH = d.height || 1080;
        var srcW = precomp ? precomp.width : geometry.width;
        var srcH = precomp ? precomp.height : geometry.height;
        var fit = precomp ? { x: 1, y: 1 } : geometry.fit;
        var signX = (t.flip_x === true || t.flip_x === 1) ? -1 : 1;
        var signY = (t.flip_y === true || t.flip_y === 1) ? -1 : 1;

        setTransform("ADBE Scale", [animation.scale], function (time) {
            var zoom = sampleKeys(animation.scale, time, [t.zoom_x == null ? 1 : t.zoom_x, t.zoom_y == null ? 1 : t.zoom_y]);
            var x = fit.x * zoom[0] * 100 * signX;
            var y = fit.y * zoom[1] * 100 * signY;
            return quarterTurn ? [y, x] : [x, y];
        });

        // Resolveのアンカーはピボット。AEではアンカーと表示位置の両方へ反映する。
        var baseAnchor = [t.anchor_x || 0, t.anchor_y || 0];
        var basePosition = [t.pan || 0, t.tilt || 0];
        setTransform("ADBE Anchor Point", [animation.anchor], function (time) {
            var anchor = sampleKeys(animation.anchor, time, baseAnchor);
            var x = fit.x !== 0 ? anchor[0] / fit.x : 0;
            var y = fit.y !== 0 ? -anchor[1] / fit.y : 0;
            // ピボットのオフセットを回転前の素材座標に戻す。
            if (orientation === 90) return [srcW / 2 + y, srcH / 2 - x];
            if (orientation === -90) return [srcW / 2 - y, srcH / 2 + x];
            if (orientation === 180) return [srcW / 2 - x, srcH / 2 - y];
            return [srcW / 2 + x, srcH / 2 + y];
        });
        setTransform("ADBE Position", [animation.position, animation.anchor], function (time) {
            var position = sampleKeys(animation.position, time, basePosition);
            var anchor = sampleKeys(animation.anchor, time, baseAnchor);
            return [compW / 2 + position[0] + anchor[0], compH / 2 - position[1] - anchor[1]];
        });
        setTransform("ADBE Rotate Z", [animation.rotation], function (time) {
            return orientation + sampleKeys(animation.rotation, time, [t.rotation || 0])[0];
        });
        if (animation.amount || (t.opacity != null && t.opacity !== 100)) {
            setTransform("ADBE Opacity", [animation.amount], function (time) {
                return sampleKeys(animation.amount, time, [t.opacity == null ? 100 : t.opacity])[0];
            });
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
        // Resolve側で素材解釈が変更された場合はレイヤー速度で表す。
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

            return "Time Remap " + Math.round(speed * 1000) / 10 + "%"
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
            + " / interlaced=" + d.interlaced
            + (d.display_start_frame != null ? " / Resolve開始フレーム=" + d.display_start_frame
                 : " / Resolve開始秒=" + d.display_start_time);

        var clips = layerImportOrder(d.clips);
        for (var i = 0; i < clips.length; i++) {
            var c = clips[i];
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
                        var roundedRate = cameraRateCorrection(c);
                        if (roundedRate && Math.abs(footage.frameRate - roundedRate) < 0.0001) {
                            try {
                                footage.mainSource.conformFrameRate = c.src_fps;
                            } catch (eRate) {
                                notices.push(c.name + ": 素材fpsの設定に失敗: " + eRate.toString());
                            }
                        }
                    }
                    footage.comment = "Resolve FPS=" + c.src_fps_raw + " / Start TC=" + c.src_start_tc
                        + " / Field=" + c.src_field;
                    imported[cacheKey] = footage;
                }

                var geometry = c.kind !== "audio" && c.transform && footage.hasVideo
                    ? sourceGeometry(c, d, footage) : null;
                var precomp = geometry ? getSourcePrecomp(footage, c, d, geometry, notices) : null;
                layer = comp.layers.add(precomp || footage);
                // 拡大時に元の画素を使い、プリコン枠を超えた素材もメインコンプで扱う。
                if (precomp) layer.collapseTransformation = true;

                if (footage.hasVideo && !footage.mainSource.isStill && c.src_fps > 0
                    && Math.abs(c.src_fps - footage.frameRate) > 0.01) {
                    notices.push(c.name + ": Resolveの素材解釈fps=" + c.src_fps
                        + " / AEの素材fps=" + footage.frameRate + "。差はTime Remapに反映（要確認）");
                }
                var status = placeLayer(layer, c, fps, footage);
                if (status.indexOf("失敗") >= 0) {
                    failed.push(c.name + " " + status);
                } else if (status !== "等速" && c.speed != null && c.speed !== 1) {
                    retimed.push(c.name + " -> " + status);
                }

                if (geometry) applyTransform(layer, c, d, geometry, precomp, notices);

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
