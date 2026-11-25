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
    var BRIDGE_DIR = Folder("~/Documents/ae_bridge").fsName;
    var JSON_PATH = BRIDGE_DIR + "/r2ae.json";

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

    var STUDIO_CONFIG = "ACES 2.0 Studio v4.0";
    var ACES_INPUT_PRESETS = {
        sonyslog3sgamut3: "sony-gamut3",
        sonysgamut3slog3: "sony-gamut3",
        slog3sgamut3: "sony-gamut3",
        sonyslog3sgamut3cine: "sony-cine",
        sonysgamut3cineslog3: "sony-cine",
        slog3sgamut3cine: "sony-cine",
        sonyveniceslog3sgamut3: "sony-venice-gamut3",
        sonyslog3venicesgamut3: "sony-venice-gamut3",
        slog3venicesgamut3: "sony-venice-gamut3",
        sonyveniceslog3sgamut3cine: "sony-venice-cine",
        sonyslog3venicesgamut3cine: "sony-venice-cine",
        slog3venicesgamut3cine: "sony-venice-cine",
        arrilogc3: "arri-logc3",
        arrilogc3ei800: "arri-logc3",
        arrialexav3logcei800: "arri-logc3",
        arriwidegamut3logc3ei800: "arri-logc3",
        arrilogc4: "arri-logc4",
        arriwidegamut4logc4: "arri-logc4",
        arrilogc4arriwidegamut4: "arri-logc4",
        acescct: "acescct",
        acescg: "acescg",
        aces20651: "aces2065-1",
        blackmagicdesignfilmgen5csc: "bmd-film-gen5",
        canonlog2cinemagamutcsc: "canon-log2-cinemagamut",
        canonlog3cinemagamutcsc: "canon-log3-cinemagamut",
        redlog3g10redwidegamutrgbcsc: "red-log3g10-rwg",
        inverserec709bt1886: "inverse-rec709-bt1886",
        inversesrgbpiecewise: "inverse-srgb-piecewise",
        // Gamma 2.2の入力にはPiecewiseの逆表示変換を近似として使う。
        inversesrgbgamma22: "inverse-srgb-piecewise"
    };

    function acesInputPreset(c) {
        if (c.kind !== "video") return null;
        var key = String(c.src_idt || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (ACES_INPUT_PRESETS.hasOwnProperty(key)) return ACES_INPUT_PRESETS[key];
        var base = key.replace(/csc$/, "");
        return ACES_INPUT_PRESETS.hasOwnProperty(base) ? ACES_INPUT_PRESETS[base] : null;
    }

    function supportsAces2() {
        var version = /^(\d+)\.(\d+)/.exec(app.version || "");
        return version && (+version[1] > 26 || (+version[1] === 26 && +version[2] >= 5));
    }

    var DEFAULT_ACES_DISPLAY = ["sRGB - Display", "ACES 2.0 - SDR 100 nits (Rec.709)"];

    function acesDisplay(odt) {
        var key = String(odt || "").toLowerCase().replace(/^\s+|\s+$/g, "");
        var sdrRec709 = DEFAULT_ACES_DISPLAY[1];
        var sdrP3 = "ACES 2.0 - SDR 100 nits (P3 D65)";
        var fixed = {
            "rec.709 bt.1886": ["Rec.1886 Rec.709 - Display", sdrRec709, "rec709"],
            "srgb gamma 2.2": ["Gamma 2.2 Rec.709 - Display", sdrRec709, "gamma22"],
            "displayp3": ["Display P3 - Display", sdrP3, "display-p3"],
            "p3-d65": ["P3-D65 - Display", sdrP3, "p3-d65"],
            "extended displayp3 (1000 nit)": ["Display P3 HDR - Display", "ACES 2.0 - HDR 1000 nits (P3 D65)", "display-p3-hdr"]
        };
        if (fixed.hasOwnProperty(key)) return fixed[key];
        var pq = /^(p3-d65|rec\.2100) st2084 \((108|500|1000|2000|4000) nit\)$/.exec(key);
        if (!pq) return DEFAULT_ACES_DISPLAY;
        if (pq[1] === "p3-d65") {
            return ["ST2084-P3-D65 - Display", "ACES 2.0 - HDR " + pq[2] + " nits (P3 D65)", "p3-pq-" + pq[2]];
        }
        if (pq[2] === "108") return DEFAULT_ACES_DISPLAY;
        return ["Rec.2100-PQ - Display", "ACES 2.0 - HDR " + pq[2] + " nits (Rec.2020)", "rec2100-pq-" + pq[2]];
    }

    function openAcesStartupProject(d, notices) {
        if ($.global.r2aeColdStart !== true || !d.aces || d.aces.mode !== "acescct") return;
        var resolveVersion = String(d.aces.version || "");
        if (resolveVersion && !/^(?:aces[ _-]*)?2\.0$/i.test(resolveVersion)) return;
        if (!supportsAces2()) {
            notices.push("ACES 2.0プロジェクトテンプレートにはAfter Effects 26.5以降が必要です");
            return;
        }

        // 既存プロジェクトを開いている場合や、AEが復元した場合は現在のプロジェクトを使う。
        var current = app.project;
        if (current && (current.file || current.numItems !== 0 || current.dirty)) {
            notices.push("起動時に開いていたAEプロジェクトへ転送します");
            return;
        }
        var template = new File(BRIDGE_DIR + "/color/r2ae-aces-project.aet");
        if (!template.exists) {
            notices.push("ACES 2.0プロジェクトテンプレートが見つかりません");
            return;
        }
        var display = acesDisplay(d.aces.odt);
        if (display[2]) {
            var matchedTemplate = new File(BRIDGE_DIR + "/color/odt/" + display[2] + ".aet");
            try {
                if (!matchedTemplate.exists || !app.openTemplate(matchedTemplate)) {
                    throw new Error("表示プロファイル付きのテンプレートを開けません");
                }
                return display.slice(0, 2);
            } catch (eDisplay) {
                notices.push("Resolveの表示プロファイルを適用できないため、sRGBを使用します: " + eDisplay.toString());
            }
        }
        try {
            if (typeof app.openTemplate !== "function" || !app.openTemplate(template)) {
                throw new Error("テンプレートから新規プロジェクトを作成できません");
            }
            return DEFAULT_ACES_DISPLAY;
        } catch (e) {
            notices.push("ACES 2.0プロジェクトを開けません: " + e.toString());
        }
    }

    function configureAces(d, notices) {
        if (!d.aces) return null;
        var resolveVersion = String(d.aces.version || "");
        if (resolveVersion && !/^(?:aces[ _-]*)?2\.0$/i.test(resolveVersion)) return null;
        var hasSupportedInput = false;
        for (var i = 0; i < d.clips.length; i++) {
            var c = d.clips[i];
            if (c.kind !== "video") continue;
            if (acesInputPreset(c)) hasSupportedInput = true;
            else notices.push(c.name + ": IDTをAEで確認してください（" + (c.src_idt || "ResolveのIDT不明") + "）");
        }
        if (!hasSupportedInput) return null;
        if (!supportsAces2()) {
            notices.push("ACES 2.0のIDTを引き継ぐにはAfter Effects 26.5以降が必要です");
            return null;
        }

        var template = new File(BRIDGE_DIR + "/color/r2ae-aces-inputs.aepx");
        if (!template.exists) template = new File(BRIDGE_DIR + "/color/r2ae-aces-inputs.aep");
        if (!template.exists || !new File(BRIDGE_DIR + "/color/r2ae-color-reference.mov").exists) {
            notices.push("IDTプリセットが見つかりません。colorフォルダを受信スクリプトと同じ階層に配置してください");
            return null;
        }

        var project = app.project;
        if (project.colorManagementSystem === 1 && project.ocioConfigurationFile === STUDIO_CONFIG) return template;
        notices.push("IDTを引き継ぐにはAE標準のACES 2.0 Studio v4.0を選択してください");
        return null;
    }

    // AEの素材差し替えは、プリセットに設定済みのOCIO入力色空間を保持する。
    function applyAcesInput(footage, src, c, template, notices) {
        var preset = acesInputPreset(c);
        if (!template || !preset || !footage.hasVideo) return footage;
        var folder = null;
        try {
            var options = new ImportOptions(template);
            options.importAs = ImportAsType.PROJECT;
            var root = app.project.rootFolder;
            var existing = {};
            for (var i = 1; i <= root.numItems; i++) existing[root.item(i).id] = true;
            app.beginSuppressDialogs();
            try { app.project.importFile(options); }
            finally { app.endSuppressDialogs(false); }

            // Undoグループ内でのプロジェクト読み込みは、戻り値が別の項目を指すことがある。
            for (var i = 1; i <= root.numItems; i++) {
                var candidate = root.item(i);
                if (candidate instanceof FolderItem && !existing[candidate.id]) {
                    folder = candidate;
                    break;
                }
            }
            if (!folder) throw new Error("IDTプリセットを読み込めません");
            var assigned = null;
            for (var i = 1; i <= folder.numItems; i++) {
                var item = folder.item(i);
                if (item.name === preset) {
                    assigned = item;
                    break;
                }
            }
            if (!assigned) throw new Error("IDTプリセットが見つかりません");
            if (c.is_sequence) assigned.replaceWithSequence(src, false);
            else assigned.replace(src);

            var original = footage.mainSource;
            var replacement = assigned.mainSource;
            if (assigned.footageMissing || assigned.width !== footage.width || assigned.height !== footage.height
                || assigned.pixelAspect !== footage.pixelAspect || assigned.hasAudio !== footage.hasAudio
                || replacement.hasAlpha !== original.hasAlpha || replacement.isStill !== original.isStill) {
                throw new Error("素材の映像・音声属性が一致しません");
            }
            if (original.hasAlpha) {
                replacement.alphaMode = original.alphaMode;
                if (original.alphaMode === AlphaMode.PREMULTIPLIED) replacement.premulColor = original.premulColor;
                replacement.invertAlpha = original.invertAlpha;
            }
            if (!original.isStill) {
                replacement.fieldSeparationType = original.fieldSeparationType;
                if (original.fieldSeparationType !== FieldSeparationType.OFF) {
                    replacement.highQualityFieldSeparation = original.highQualityFieldSeparation;
                }
                replacement.removePulldown = original.removePulldown;
                if (replacement.conformFrameRate !== original.conformFrameRate) {
                    replacement.conformFrameRate = original.conformFrameRate;
                }
                replacement.loop = original.loop;
                if (Math.abs(assigned.duration - footage.duration) > 0.00001
                    || Math.abs(assigned.frameRate - footage.frameRate) > 0.00001) {
                    throw new Error("素材の尺またはfpsが一致しません");
                }
            }
            assigned.name = footage.name;
            assigned.parentFolder = footage.parentFolder;
            footage.remove();
            return assigned;
        } catch (e) {
            notices.push(c.name + ": AEでIDTを確認してください（" + e.toString() + "）");
            return footage;
        } finally {
            if (folder instanceof FolderItem) folder.remove();
        }
    }

    // この転送内だけで再利用。既存コンプの手動解釈/プロキシに影響されない。
    var imported = {};
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
        return path + "|" + !!c.is_sequence + "|" + rate + "|" + c.src_field + "|" + (acesInputPreset(c) || "");
    }
    function fieldMode(value) {
        var v = String(value || "").toLowerCase();
        if (v === "progressive") return FieldSeparationType.OFF;
        if (v === "upper field first" || v === "upper field" || v === "upper") return FieldSeparationType.UPPER_FIELD_FIRST;
        if (v === "lower field first" || v === "lower field" || v === "lower") return FieldSeparationType.LOWER_FIELD_FIRST;
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
            fit: getFitFactor(d.input_scaling, orientedWidth, orientedHeight, d.width, d.height)
        };
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

    function applyTransform(layer, c, d, geometry, notices) {
        var t = c.transform;
        var orientation = geometry.rotation;
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
        var srcW = geometry.width;
        var srcH = geometry.height;
        var fit = geometry.fit;
        var signX = (t.flip_x === true || t.flip_x === 1) ? -1 : 1;
        var signY = (t.flip_y === true || t.flip_y === 1) ? -1 : 1;

        setTransform("ADBE Scale", [animation.scale], function (time) {
            var zoom = sampleKeys(animation.scale, time, [t.zoom_x == null ? 1 : t.zoom_x, t.zoom_y == null ? 1 : t.zoom_y]);
            var x = fit.x * zoom[0] * 100 * signX;
            var y = fit.y * zoom[1] * 100 * signY;
            return geometry.quarterTurn ? [y, x] : [x, y];
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

    function sourceTiming(c, fps, footage) {
        var hasMotion = footage.hasVideo && !footage.mainSource.isStill;
        var srcFps = c.src_fps > 0 ? c.src_fps : (hasMotion ? footage.frameRate : fps);
        var aeFps = hasMotion ? footage.frameRate : srcFps;
        // VFRなどでデコーダーのフレーム数が異なっても、実時間が同じならコンフォームしない。
        var useElapsedTime = hasMotion && !c.is_sequence && c.src_frames > 0
            && (!c.camera_fps || Math.abs(c.camera_fps - srcFps) <= 0.01)
            && Math.abs(c.src_frames - footage.duration * aeFps) > 1
            && Math.abs(c.src_frames / srcFps - footage.duration) <= Math.max(1 / srcFps, 1 / aeFps);
        var inSec = useElapsedTime
            ? (c.source_in_time != null ? c.source_in_time : c.source_in / srcFps)
            : c.source_in / aeFps;
        return { inSec: inSec, rate: useElapsedTime ? 1 : srcFps / aeFps,
            needsConform: !useElapsedTime && hasMotion && Math.abs(srcFps - aeFps) > 0.01 };
    }

    function setRetimeKeys(layer, times, values) {
        layer.startTime = 0;
        layer.timeRemapEnabled = true;
        var tr = layer.property("ADBE Time Remapping");
        if (!tr) throw new Error("Time Remapプロパティが取得できません");
        var defaults = [];
        for (var i = 1; i <= tr.numKeys; i++) defaults.push(tr.keyTime(i));
        tr.setValuesAtTimes(times, values);
        // 有効化時のキーは、同じ時刻に転送したキーがある場合だけ残す。
        for (var j = defaults.length - 1; j >= 0; j--) {
            var index = tr.nearestKeyIndex(defaults[j]);
            var time = tr.keyTime(index);
            var k = 0;
            while (k < times.length && times[k] < time - 1e-6) k++;
            if (Math.abs(time - defaults[j]) < 1e-6
                && (k === times.length || Math.abs(times[k] - time) > 1e-6)) tr.removeKey(index);
        }
        for (var n = 1; n <= tr.numKeys; n++) {
            tr.setInterpolationTypeAtKey(n, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        }
    }

    function placeMappedFrames(layer, c, fps, footage) {
        var map = c.retime_keys;
        var count = Math.round(c.duration);
        var sourceCount = Math.round(footage.duration * footage.frameRate);
        if (!(c.src_fps > 0) || !footage.hasVideo || footage.mainSource.isStill
            || count < 1 || Math.abs(c.duration - count) > 1e-6
            || Math.abs(c.offset - Math.round(c.offset)) > 1e-6 || sourceCount < 1
            || (c.src_frames > 0 && Math.abs(c.src_frames - sourceCount) > 1)) {
            throw new Error("素材のフレーム数またはクリップの境界が一致しません");
        }

        var times = [], values = [];
        function addKey(frame, sourceFrame) {
            times.push((c.offset + frame) / fps);
            // サブフレーム誤差で前後のコマを拾わないよう、表示区間内を指す。
            values.push((sourceFrame + 0.25) / footage.frameRate);
        }
        var segment = 0, previousFrame, previousDelta;
        for (var i = 0; i < count; i++) {
            var time = i / fps;
            while (segment + 2 < map.length && time > map[segment + 1][0]) segment++;
            var a = map[segment], b = map[segment + 1];
            if (!a || !b || !(b[0] > a[0])) throw new Error("速度マップの時刻が不正です");
            var t = Math.max(0, Math.min(1, (time - a[0]) / (b[0] - a[0])));
            var position = (a[1] + (b[1] - a[1]) * t) * c.src_fps;
            // 実測したResolveの境界付近の丸め。素材フレーム単位で吸収する。
            var frame = Math.floor(position + 0.0025);
            if (!isFinite(frame) || frame < -1 || frame > sourceCount) {
                throw new Error("速度マップが素材尺の範囲外です");
            }
            frame = Math.max(0, Math.min(sourceCount - 1, frame));
            if (i === 0) {
                addKey(0, frame);
            } else {
                var delta = frame - previousFrame;
                // 同じコマ間隔が続く区間は端点だけで表せる。
                if (i > 1 && delta !== previousDelta) addKey(i - 1, previousFrame);
                previousDelta = delta;
            }
            previousFrame = frame;
        }
        if (count > 1) addKey(count - 1, previousFrame);
        setRetimeKeys(layer, times, values);
        layer.inPoint = c.offset / fps;
        layer.outPoint = (c.offset + c.duration) / fps;
        return "Time Remap（元コマを合わせる）";
    }

    // レイヤーの配置。リタイムがある場合はタイムリマップで再現する。
    // 失敗したクリップは外側で除去し、誤った等速配置を残さない。
    // 戻り値: 状態を表す文字列（診断用）
    function placeLayer(layer, c, fps, footage, timing, notices) {
        var offsetSec = c.offset / fps;
        var durSec = c.duration / fps;
        var inSec = timing.inSec;
        var speed = ((c.speed != null) ? c.speed : 1) * timing.rate;

        if (c.retime_keys && c.kind === "video") {
            try {
                return placeMappedFrames(layer, c, fps, footage);
            } catch (e) {
                if (layer.timeRemapEnabled) layer.timeRemapEnabled = false;
                notices.push(c.name + ": コマ合わせに失敗。従来の速度で転送します（" + e.toString() + "）");
            }
        }

        function placeNormal() {
            layer.startTime = offsetSec - inSec;
            layer.inPoint = offsetSec;
            layer.outPoint = offsetSec + durSec;
        }

        if ((footage.hasVideo && footage.mainSource.isStill) || Math.abs(speed - 1) < 0.0001) {
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

            // タイムリマップの値は素材の尺を超えられないためクランプする。
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

            setRetimeKeys(layer, [t1, t2], [startVal, endVal]);

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
    var failed = [];
    var retimed = [];
    var notices = d.warnings || [];
    var startupDisplay = openAcesStartupProject(d, notices);
    app.beginUndoGroup("Import from DaVinci Resolve");

    try {
        if (!app.project) app.newProject();
        var acesTemplate = configureAces(d, notices);

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
        if (d.aces && d.aces.odt) comp.comment += "\nResolve ODT: " + d.aces.odt;
        if (startupDisplay) comp.comment += "\nAE Display Color Space: " + startupDisplay.join(" / ");

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
                    footage = applyAcesInput(footage, src, c, acesTemplate, notices);
                    footage.comment = "Resolve FPS=" + c.src_fps_raw + " / Start TC=" + c.src_start_tc
                        + " / Field=" + c.src_field;
                    if (c.src_idt) footage.comment += " / Resolve IDT=" + c.src_idt;
                    imported[cacheKey] = footage;
                }

                var geometry = c.kind !== "audio" && c.transform && footage.hasVideo
                    ? sourceGeometry(c, d, footage) : null;
                layer = comp.layers.add(footage);

                var timing = sourceTiming(c, fps, footage);
                if (timing.needsConform) {
                    notices.push(c.name + ": Resolveの素材解釈fps=" + c.src_fps
                        + " / AEの素材fps=" + footage.frameRate + "。差はTime Remapに反映（要確認）");
                }
                var status = placeLayer(layer, c, fps, footage, timing, notices);
                if (status.indexOf("失敗") >= 0) {
                    failed.push(c.name + " " + status);
                } else if (status !== "等速" && (c.retime_keys || (c.speed != null && c.speed !== 1))) {
                    retimed.push(c.name + " -> " + status);
                }

                if (geometry) applyTransform(layer, c, d, geometry, notices);

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
