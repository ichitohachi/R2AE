-- r2ae.lua  (R2AE: Resolve to After Effects ブリッジ / Lua)
-- 対応OS: macOS / Windows
--
-- 置き場所:
--   macOS   : ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/r2ae.lua
--   Windows : %APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\r2ae.lua
--   ※ r2ae_receive.jsx は両OSとも「ドキュメント」フォルダ内の ae_bridge に置く
--       macOS   : ~/Documents/ae_bridge/
--       Windows : %USERPROFILE%\Documents\ae_bridge\
--
-- 動作:
--   タイムラインに設定したIN/OUT範囲に重なる全トラック(V/A)のクリップを
--   まとめてAEへ送る。範囲からはみ出した分は切り詰められる。
--   コンプ解像度とクリップのスケール/位置はResolve側の見た目に合わせる。
--
-- AEへの送信方式はOSによって異なる:
--   macOS   : AppleScript(osascript)経由でAEに直接スクリプト実行を指示する。
--   Windows : 起動中のAfter Effectsプロセスを検出し、
--             AfterFX.exe -r で直接スクリプト実行を指示する。
--             After Effectsを先に起動しておく必要がある
--             （未起動の場合は自動起動せず、JSONの書き出しのみ行う）。

-- package.config の1文字目はディレクトリ区切り文字（Windowsは "\"）。
-- 外部コマンドに依存しない、Lua標準機能だけでのOS判定方法。
local IS_WINDOWS = package.config:sub(1, 1) == "\\"

local function get_home_dir()
    if IS_WINDOWS then
        return os.getenv("USERPROFILE")
            or ((os.getenv("HOMEDRIVE") or "C:") .. (os.getenv("HOMEPATH") or "\\Users\\Default"))
    end
    return os.getenv("HOME")
end

local BRIDGE_DIR = get_home_dir() .. "/Documents/ae_bridge"
local JSON_PATH = BRIDGE_DIR .. "/r2ae.json"
local JSX_PATH = BRIDGE_DIR .. "/r2ae_receive.jsx"

-- ---- 設定 ---------------------------------------------------------------

-- オーディオの扱い
--   "auto"       : 同じ素材・配置・トリム・速度のAをVへ統合（既定）
--   "video_only" : Aトラックのうち映像と同一ファイルのものは常に捨てる
--   "separate"   : 常にAトラックを別レイヤーにし、全映像レイヤーの音声はオフ
local AUDIO_MODE = "auto"
-- 同位置でも別チャンネル/意図した重ね録りの可能性があるため、既定では統合しない
local DEDUPE_AUDIO = false
-- GetMarkInOut の座標系を明示。バージョン実測で絶対値の場合だけ変更
local MARK_COORDINATES = "relative"
-- インターレースでAPIのfpsがフィールド数を返す場合、実測したフレーム数/秒を指定
local TIMELINE_FRAME_RATE_OVERRIDE = nil

-- 入力スケーリング（プロジェクト設定「解像度が一致しないファイル」に合わせる）
--   "fit"     : 最長辺をマッチ / 黒帯を挿入（内接フィット）
--   "fill"    : 最短辺をマッチ / 画像を切り抜き（外接フィット）
--   "stretch" : フレームに合わせて引き伸ばし
--   "none"    : 中央に原寸配置
local INPUT_SCALING = "fit"

-- Resolveの回転方向がAEと逆になる場合は -1 にする
-- （実測により既定を -1 にしている）
local ROTATION_SIGN = -1

-- 速度変更（リタイム）をAEのタイムリマップに反映するか
local ENABLE_SPEED = true

-- 無効化されたトラックを送信対象から除外するか
local RESPECT_TRACK_ENABLE = true

-- 無効化されたクリップ（Resolveで D を押した状態）を除外するか
local RESPECT_CLIP_ENABLE = true


-- ---- ユーティリティ ----------------------------------------------------

local function file_exists(path)
    local f = io.open(path, "r")
    if f then f:close() return true end
    return false
end

local function shell_quote(text)
    return "'" .. text:gsub("'", "'\\''") .. "'"
end
local function apple_quote(text)
    return '"' .. text:gsub("\\", "\\\\"):gsub('"', '\\"') .. '"'
end
local function ensure_dir(path)
    if IS_WINDOWS then
        -- Windowsのmkdirは "/" 区切りを受け付けないため "\" に変換する
        local winPath = path:gsub("/", "\\")
        os.execute('if not exist "' .. winPath .. '" mkdir "' .. winPath .. '"')
    else
        os.execute('mkdir -p ' .. shell_quote(path))
    end
end

local function json_escape(s)
    if s == nil then return "" end
    s = tostring(s)
    s = s:gsub("\\", "\\\\")
    s = s:gsub('"', '\\"')
    s = s:gsub("[%z\1-\31]", function(c)
        return string.format("\\u%04x", string.byte(c))
    end)
    return s
end

-- Resolveは連番クリップの File Path を "name_[0000-0076].png" のような
-- 範囲表記でまとめて返すが、この名前のファイルは実際にはディスク上に
-- 存在しない（実ファイルは name_0000.png ～ name_0076.png の個別連番）。
-- この表記を検出し、先頭フレームの実ファイルパスに変換する。
-- 戻り値: 変換後のパス, 連番かどうか
local function resolve_sequence_path(path)
    local dir, prefix, startNum, endNum, ext =
        path:match("^(.*[/\\])([^/\\]-)%[(%d+)%-(%d+)%]([^/\\]*)$")
    if not dir then
        return path, false
    end
    local firstFramePath = dir .. prefix .. startNum .. ext
    return firstFramePath, true
end

-- macOS: /Applications 内の "Adobe After Effects *.app" を新しい順に探す
local function find_ae_app_name_mac()
    local p = io.popen('ls /Applications | grep "^Adobe After Effects" | sort -r')
    local result = p:read("*l")
    p:close()
    if result then return (result:gsub("%.app$", "")) end
    return nil
end

-- Windows: AfterFX.exe が起動中かどうか調べる（案内メッセージの出し分け用）
local function is_ae_running_windows()
    local p = io.popen('tasklist /FI "IMAGENAME eq AfterFX.exe" /NH 2>nul')
    if not p then return false end
    local out = p:read("*a")
    p:close()
    return out ~= nil and out:find("AfterFX.exe") ~= nil
end

-- ---- Resolve情報取得 ----------------------------------------------------

if not resolve then
    print("このスクリプトはResolve内から実行してください")
    return
end

local project = resolve:GetProjectManager():GetCurrentProject()
if not project then print("プロジェクトが開かれていません") return end

local timeline = project:GetCurrentTimeline()
if not timeline then print("タイムラインが開かれていません") return end

-- 設定は現在のタイムラインを優先。未公開のキーを推測せずスナップショットを読む。
local warnings = {}
local function warn(message)
    for _, existing in ipairs(warnings) do if existing == message then return end end
    warnings[#warnings + 1] = message
    print("R2AE: " .. message)
end
local function settings(object)
    local ok, value = pcall(function() return object:GetSetting() end)
    return ok and type(value) == "table" and value or {}
end
local projectSettings, timelineSettings = settings(project), settings(timeline)
local function setting(key)
    local v = timelineSettings[key]
    if v ~= nil and v ~= "" then return v end
    return projectSettings[key]
end
local function as_bool(v)
    if v == true or v == 1 or v == "1" or v == "true" then return true end
    if v == false or v == 0 or v == "0" or v == "false" then return false end
    return nil
end
local function parse_fps(value)
    local text = tostring(value or "")
    local n, d = text:match("^%s*(%d+)%s*/%s*(%d+)%s*$")
    local rate
    if n then
        if tonumber(d) == 0 then return nil end
        rate = tonumber(n) / tonumber(d)
    else
        local digits, suffix = text:match("^%s*(%d+%.?%d*)%s*(%a*)%s*$")
        suffix = (suffix or ""):upper()
        if suffix ~= "" and suffix ~= "DF" and suffix ~= "NDF" then return nil end
        rate = tonumber(digits)
    end
    if not rate or rate <= 0 then return nil end
    -- UIの省略表記を実レートに正規化。整数の24/30/60とは区別する。
    local ntsc = { [23.976] = 24000/1001, [23.98] = 24000/1001,
        [29.97] = 30000/1001, [47.952] = 48000/1001,
        [59.94] = 60000/1001, [119.88] = 120000/1001 }
    return ntsc[rate] or rate
end
local fpsRaw = setting("timelineFrameRate")
local fps = parse_fps(TIMELINE_FRAME_RATE_OVERRIDE or fpsRaw)
local compW = tonumber(setting("timelineResolutionWidth"))
local compH = tonumber(setting("timelineResolutionHeight"))
if not fps or not compW or compW <= 0 or not compH or compH <= 0 then
    print("R2AE: タイムラインのfps/解像度を取得できません。推測で転送せず終了します")
    return
end
-- Resolve exposes this as timelineInterlaceProcessing (verified in Resolve).
local interlaced = as_bool(setting("timelineInterlaceProcessing"))
-- Resolve's interlaced 50/59.94/60 timelines count fields in item and mark APIs.
-- Keep fps as the API clock for source trimming/speed; convert only exported
-- timeline coordinates to full-frame composition units.
local ticksPerFrame = (interlaced and fps >= 49) and 2 or 1
local compFps = fps / ticksPerFrame
local startTC = timeline:GetStartTimecode() or ""
local dropFrame = as_bool(setting("timelineDropFrameTimecode"))
if dropFrame == nil then
    dropFrame = tostring(fpsRaw):upper():match("%sDF%s*$") ~= nil
        or startTC:find(";", 1, true) ~= nil
end
local pixelRaw = setting("timelinePixelAspectRatio")
local pixelAspect = tonumber(pixelRaw)
if not pixelAspect then
    pixelAspect = 1
    if pixelRaw and pixelRaw ~= "Square" and pixelRaw ~= "square" then
        warn("ピクセル縦横比を解釈できません: " .. tostring(pixelRaw) .. "（正方形として転送）")
    end
end
if interlaced then
    warn("インターレース: AEのコンポにはフィールド順の設定はありません。素材のフィールド分離と出力時のField Renderingを確認してください")
elseif interlaced == nil then
    warn("タイムラインのインターレース設定をAPIから取得できません。r2ae_debugで確認してください")
end

-- 送信範囲（IN/OUT）を取得する。rangeOut は排他的（その値のフレームは含まない）
local function get_mark_in_out()
    local ok, mio = pcall(function() return timeline:GetMarkInOut() end)
    if not ok or type(mio) ~= "table" then return nil end

    local function complete(r)
        return type(r) == "table" and tonumber(r["in"]) and tonumber(r["out"])
    end
    local v, au = mio.video, mio.audio
    if complete(v) and complete(au) and
        (v["in"] ~= au["in"] or v["out"] ~= au["out"]) then
        print("映像と音声のIN/OUTが異なります。同じ範囲に設定してください")
        return nil
    end
    local r = complete(v) and v or (complete(au) and au or nil)
    if not r then return nil end
    local a, b = tonumber(r["in"]), tonumber(r["out"])
    if a < 0 or b < a then return nil end
    -- 数値の大小による推測は、長いタイムラインで座標を誤認する。
    if MARK_COORDINATES == "relative" then
        local tlStart = timeline:GetStartFrame() or 0
        a, b = a + tlStart, b + tlStart
    elseif MARK_COORDINATES ~= "absolute" then
        error("MARK_COORDINATES は relative / absolute を指定してください")
    end
    return a, b + 1
end

local rangeIn, rangeOut = get_mark_in_out()
if not rangeIn then
    print("タイムラインにIN/OUTが設定されていません（I / O キーで範囲を指定してください）")
    return
end

-- 送信範囲に重なるクリップを収集する
local collected = {}
local skipped = 0

-- 無効トラックを除外する（古いバージョンでAPIが無い場合は常に有効扱い）
local disabledTracks = 0
local function is_track_enabled(trackType, trackIndex)
    if not RESPECT_TRACK_ENABLE then return true end
    local ok, v = pcall(function()
        return timeline:GetIsTrackEnabled(trackType, trackIndex)
    end)
    if not ok or v == nil then return true end
    return v == true
end

-- 無効クリップを除外する（古いバージョンでAPIが無い場合は常に有効扱い）
local disabledClips = 0
local function is_clip_enabled(item)
    if not RESPECT_CLIP_ENABLE then return true end
    local ok, v = pcall(function() return item:GetClipEnabled() end)
    if not ok or v == nil then return true end
    return v == true
end

-- インスペクタのTransform値を読む（取得できない場合はnil）
local function get_transform(item)
    local ok, p = pcall(function() return item:GetProperty() end)
    if not ok or type(p) ~= "table" then return nil end
    local function num(key, default)
        local v = p[key]
        if v == nil then return default end
        if type(v) == "boolean" then return v and 1 or 0 end
        return tonumber(v) or default
    end
    return {
        zoom_x   = num("ZoomX", 1),
        zoom_y   = num("ZoomY", 1),
        pan      = num("Pan", 0),
        tilt     = num("Tilt", 0),
        rotation = num("RotationAngle", 0),
        anchor_x = num("AnchorPointX", 0),
        anchor_y = num("AnchorPointY", 0),
        flip_x   = num("FlipX", 0),
        flip_y   = num("FlipY", 0),
        opacity  = num("Opacity", 100),
    }
end

-- 定速リタイムの倍率を求める。1.0 = 等速、負値 = 逆再生
-- 素材の消費フレーム数をトリム情報とソースフレーム番号の2通りで求め、
-- 一致した場合のみ採用する（どちらかが信用できない環境があるため）
local function get_speed(item, props)
    local dur = item:GetDuration()
    if not dur or dur <= 0 then return 1, nil end

    -- 方法A: メディア総尺から前後のトリム量を引く
    local usedA = nil
    local frames = tonumber(props and props["Frames"])
    local lo = item:GetLeftOffset()
    local ro = item:GetRightOffset()
    if frames and lo and ro then
        usedA = frames - lo - ro
    end

    -- 方法B: ソース側の開始/終了フレーム番号の差
    local usedB, reverse = nil, false
    local ok1, ss = pcall(function() return item:GetSourceStartFrame() end)
    local ok2, se = pcall(function() return item:GetSourceEndFrame() end)
    if ok1 and ok2 and ss and se then
        usedB = math.abs(se - ss) + 1
        reverse = (se < ss)
    end

    -- 両方取れて食い違う場合は判断できないので等速にする
    if usedA and usedB and math.abs(usedA - usedB) > 1 then
        return 1, string.format("判定不一致 A=%d B=%d dur=%d", usedA, usedB, dur)
    end

    local used = usedA or usedB
    if not used or used <= 0 then return 1, nil end

    -- 素材fpsとタイムラインfpsが異なる場合、Resolveがコンフォームするため
    -- フレーム数の比だけでは速度と区別がつかない。fps比で割り戻す。
    local srcFps = parse_fps(props and props["FPS"])
    local conform = 1
    if srcFps and srcFps > 0 and fps and fps > 0 then
        conform = srcFps / fps
    end

    local sp = used / (dur * conform)

    -- 誤差程度の差は等速とみなす
    if math.abs(used - dur * conform) <= 1 then
        sp = 1
        if not reverse then return 1, nil end
    end
    if reverse then sp = -sp end

    return sp, string.format(
        "used=%d dur=%d srcFps=%s conform=%.4f speed=%.4f",
        used, dur, tostring(srcFps), conform, sp)
end

local function collect_track(trackType, trackIndex)
    if not is_track_enabled(trackType, trackIndex) then
        disabledTracks = disabledTracks + 1
        return
    end
    local items = timeline:GetItemListInTrack(trackType, trackIndex)
    if not items then return end
    for _, item in ipairs(items) do
        local s = item:GetStart(true)
        local e = item:GetEnd(true)
        if s < rangeOut and e > rangeIn then
            if not is_clip_enabled(item) then
                disabledClips = disabledClips + 1
            else
                local mpi = item:GetMediaPoolItem()
                if mpi then
                    local props = mpi:GetClipProperty()
                    local path = props["File Path"]
                    local isSequence = false
                    if path and path ~= "" then
                        path, isSequence = resolve_sequence_path(path)
                    end
                    if path and path ~= "" and file_exists(path) then
                        local sourceIn = item:GetLeftOffset() or 0
                        if item.GetSourceStartFrame then
                            local ok, v = pcall(function()
                                return item:GetSourceStartFrame()
                            end)
                            if ok and v then sourceIn = v end
                        end

                        local speed = 1
                        if ENABLE_SPEED and parse_fps(props["FPS"]) then
                            local sp, info = get_speed(item, props)
                            speed = sp
                            if info then
                                print(string.format("  [retime] %s : %s",
                                    item:GetName(), info))
                                warn(item:GetName() .. ": 速度はAPIフレーム範囲からの推定です。" .. info)
                            end
                        end

                        -- 素材fps。source_in は素材フレーム基準の値なので、
                        -- タイムラインfpsと異なる場合の換算に必要（AE側で使う）
                        local srcFps = parse_fps(props["FPS"])
                        if not srcFps or srcFps <= 0 then srcFps = nil end

                        -- 範囲からはみ出した分を切り詰める
                        -- リタイム中は素材側の進み方も倍率に従う
                        -- 切り詰め量はタイムラインフレーム数なので、
                        -- fps比（コンフォーム）を掛けて素材フレームに換算する
                        local cs = math.max(s, rangeIn)
                        local ce = math.min(e, rangeOut)
                        local conform = (srcFps and fps > 0) and (srcFps / fps) or 1
                        sourceIn = sourceIn + (cs - s) * speed * conform

                        -- 素材解像度（スケール計算に使う）
                        local sw, sh = nil, nil
                        local resStr = props["Resolution"]
                        if resStr then
                            local a, b = resStr:match("(%d+)x(%d+)")
                            if a then sw, sh = tonumber(a), tonumber(b) end
                        end

                        table.insert(collected, {
                            name = item:GetName(),
                            path = path,
                            kind = trackType,
                            track = trackIndex,
                            start = cs,
                            duration = ce - cs,
                            source_in = sourceIn,
                            mute_audio = false,
                            speed = speed,
                            src_fps = srcFps,
                            src_fps_raw = tostring(props["FPS"] or ""),
                            src_start_tc = tostring(props["Start TC"] or ""),
                            src_field = tostring(props["Field Dominance"] or ""),
                            src_w = sw,
                            src_h = sh,
                            is_sequence = isSequence,
                            transform = (trackType == "video")
                                and get_transform(item) or nil,
                        })
                    else
                        skipped = skipped + 1
                    end
                else
                    skipped = skipped + 1
                end
            end
        end
    end
end

-- オーディオを先に集め、その後ビデオ（AE側で下から順に積むため）
local audioTracks = timeline:GetTrackCount("audio") or 0
for i = audioTracks, 1, -1 do
    collect_track("audio", i)
end

local videoTracks = timeline:GetTrackCount("video") or 0
for i = 1, videoTracks do
    collect_track("video", i)
end

if #collected == 0 then
    if disabledTracks > 0 or disabledClips > 0 then
        print(string.format(
            "対象クリップがありません（無効トラック %d 本 / 無効クリップ %d 本を除外）",
            disabledTracks, disabledClips))
    else
        print("IN/OUT範囲にクリップがありません")
    end
    return
end

-- ---- 音声の二重鳴り解決 ---------------------------------------------------

-- ステレオがA1/A2に分割されている場合、同一ファイル・同一位置・同一尺の
-- オーディオアイテムが複数現れる。AEはファイル単位で全チャンネルを読むため、
-- こうした重複は1つに畳む（トラック番号の小さい方を残す）
local function dedupe_audio(list)
    local kept = {}
    local indexByKey = {}
    local dupes = 0
    for _, c in ipairs(list) do
        if c.kind == "audio" then
            local key = table.concat(
                { c.path, c.start, c.duration, c.source_in }, "|")
            local idx = indexByKey[key]
            if idx then
                dupes = dupes + 1
                if c.track < kept[idx].track then
                    kept[idx] = c
                end
            else
                table.insert(kept, c)
                indexByKey[key] = #kept
            end
        else
            table.insert(kept, c)
        end
    end
    return kept, dupes
end

local function resolve_audio_duplicates(list)
    local function same_number(a, b)
        return type(a) == "number" and type(b) == "number" and math.abs(a - b) < 0.000001
    end
    local function same_timing(a, b)
        return a.path == b.path and same_number(a.start, b.start)
            and same_number(a.duration, b.duration)
            and same_number(a.source_in, b.source_in)
            and same_number(a.speed or 1, b.speed or 1)
            and same_number(a.src_fps or fps, b.src_fps or fps)
            and a.is_sequence == b.is_sequence
    end
    -- Start muted: only an enabled, collected A item can restore embedded sound.
    for _, c in ipairs(list) do
        if c.kind == "video" then c.mute_audio = AUDIO_MODE ~= "video_only" end
    end
    local kept, merged = {}, 0
    for _, c in ipairs(list) do
        local drop = false
        if c.kind == "audio" and AUDIO_MODE == "auto" then
            -- Multiple identical A items may represent channel splits or intentional
            -- layering. Do not collapse those without channel mapping information.
            local count = 0
            for _, a in ipairs(list) do
                if a.kind == "audio" and same_timing(c, a) then count = count + 1 end
            end
            if count == 1 then
                for _, v in ipairs(list) do
                    if v.kind == "video" and v.mute_audio and same_timing(c, v) then
                        v.mute_audio = false
                        drop = true
                        break -- One A item enables only one V instance.
                    end
                end
            end
        elseif c.kind == "audio" and AUDIO_MODE == "video_only" then
            for _, v in ipairs(list) do
                if v.kind == "video" and v.path == c.path then drop = true break end
            end
        end
        if drop then merged = merged + 1 else table.insert(kept, c) end
    end
    return kept, merged
end

local dedupedList, dupeCount = collected, 0
if DEDUPE_AUDIO then dedupedList, dupeCount = dedupe_audio(collected) end
if audioTracks > 0 then
    warn("音量・パン・チャンネル割当・Fairlight処理は未転送です。分割モノ音声はAEでチャンネルを確認してください")
end
local finalList, mergedCount = resolve_audio_duplicates(dedupedList)

-- コンプ範囲はマークしたIN/OUTをそのまま使う
local minStart, maxEnd = rangeIn, rangeOut
local totalDuration = maxEnd - minStart

-- ---- JSON書き出し --------------------------------------------------------

ensure_dir(BRIDGE_DIR)

local parts = {}
for _, c in ipairs(finalList) do
    local extra = string.format(', "src_fps_raw": "%s", "src_start_tc": "%s", "src_field": "%s"',
        json_escape(c.src_fps_raw), json_escape(c.src_start_tc), json_escape(c.src_field))
    if c.src_fps then
        extra = extra .. string.format(', "src_fps": %s', tostring(c.src_fps))
    end
    if c.src_w and c.src_h then
        extra = extra .. string.format(', "src_w": %d, "src_h": %d', c.src_w, c.src_h)
    end
    if c.is_sequence then
        extra = extra .. ', "is_sequence": true'
    end
    if c.transform then
        local t = c.transform
        extra = extra .. string.format(
            ', "transform": {"zoom_x": %s, "zoom_y": %s, "pan": %s, "tilt": %s, ' ..
            '"rotation": %s, "anchor_x": %s, "anchor_y": %s, ' ..
            '"flip_x": %s, "flip_y": %s, "opacity": %s}',
            tostring(t.zoom_x), tostring(t.zoom_y), tostring(t.pan), tostring(t.tilt),
            tostring(t.rotation * ROTATION_SIGN),
            tostring(t.anchor_x), tostring(t.anchor_y),
            tostring(t.flip_x), tostring(t.flip_y), tostring(t.opacity)
        )
    end
    table.insert(parts, string.format(
        '    {"name": "%s", "path": "%s", "kind": "%s", "track": %d, ' ..
        '"offset": %.10f, "duration": %.10f, "source_in": %.6f, "mute_audio": %s, ' ..
        '"speed": %s%s}',
        json_escape(c.name), json_escape(c.path), c.kind, c.track,
        (c.start - minStart) / ticksPerFrame, c.duration / ticksPerFrame, c.source_in,
        tostring(c.mute_audio == true), tostring(c.speed or 1), extra
    ))
end

local warningJSON = {}
for _, message in ipairs(warnings) do
    warningJSON[#warningJSON + 1] = '"' .. json_escape(message) .. '"'
end
local json = string.format(
[[{
  "schema_version": 2,
  "comp_name": "%s",
  "width": %d,
  "height": %d,
  "fps": %s,
  "duration": %.10f,
  "input_scaling": "%s",
  "drop_frame": %s,
  "display_start_frame": %s,
  "display_start_time": %.10f,
  "resolve_clock_fps": %s,
  "resolve_ticks_per_frame": %d,
  "pixel_aspect": %s,
  "interlaced": %s,
  "fps_raw": "%s",
  "warnings": [%s],
  "clips": [
%s
  ]
}]],
    json_escape(timeline:GetName() .. "_AE"),
    compW, compH, tostring(compFps), totalDuration / ticksPerFrame, INPUT_SCALING,
    tostring(dropFrame), rangeIn % ticksPerFrame == 0 and tostring(rangeIn / ticksPerFrame) or "null",
    rangeIn / fps, tostring(fps), ticksPerFrame, tostring(pixelAspect),
    interlaced == nil and "null" or tostring(interlaced), json_escape(fpsRaw),
    table.concat(warningJSON, ","),
    table.concat(parts, ",\n")
)

local f, writeError = io.open(JSON_PATH, "w")
if not f then print("JSONを開けません: " .. tostring(writeError)) return end
local written, writeMessage = f:write(json)
local closed, closeMessage = f:close()
if not written or not closed then
    print("JSONの保存に失敗: " .. tostring(writeMessage or closeMessage))
    return
end

print(string.format(
    "範囲: %d - %d / 収集: %d クリップ / 分割音声を統合: %d / " ..
    "リンク音声を統合: %d / スキップ: %d / 無効トラック除外: %d / 無効クリップ除外: %d",
    rangeIn, rangeOut - 1,
    #finalList, dupeCount, mergedCount, skipped, disabledTracks, disabledClips))

-- ---- AE起動 --------------------------------------------------------------

if not file_exists(JSX_PATH) then
    print("受信JSXが見つかりません: " .. JSX_PATH)
    return
end

local sent = false

if IS_WINDOWS then
    -- Windows: 起動中のAfter Effectsへ AfterFX.exe -r でJSXを送る。
    -- COMは使用しない。AfterFX.exeのパス取得だけPowerShellを使用する。
    local jsxWin = JSX_PATH:gsub("/", "\\")

    -- 現在起動しているAfterFX.exeの実パスを取得する。
    -- 複数バージョンがインストールされていても、起動中のAEを優先する。
    local function find_running_afterfx()
        local p = io.popen(
            "powershell.exe -NoProfile -Command " ..
            "\"(Get-Process AfterFX -ErrorAction SilentlyContinue | " ..
            "Select-Object -First 1 -ExpandProperty Path)\""
        )
        if not p then return nil end
        local result = p:read("*a")
        p:close()
        if result then
            result = result:gsub("^%s+", ""):gsub("%s+$", "")
            if result ~= "" and file_exists(result) then
                return result
            end
        end
        return nil
    end

    local afterfx = find_running_afterfx()

    if not afterfx then
        print("R2AE: 起動中のAfter Effectsが見つかりません")
        print("      After Effectsを起動してからResolveで再実行してください。")
        print("      JSONは書き出されています。")
        print("      JSX: " .. jsxWin)
    else
        -- cmd.exe経由で単純に AfterFX.exe -r "JSX" を実行する。
        -- パス中の & などの特殊文字対策として引用符で囲む。
        -- CMDで実際に動作確認できた形式に合わせる。
        -- ユーザー名にスペースがある環境でもJSXパスを1つの引数として渡す。
        local cmd = string.format(
            'cmd.exe /d /c ""%s" -r "%s""',
            afterfx:gsub('"', '""'),
            jsxWin:gsub('"', '""')
        )

        local result = os.execute(cmd)
        sent = result == true or result == 0

        if sent then
            print("R2AE: Windows / 起動中のAEへJSXを送信しました")
            print("      AfterFX: " .. afterfx)
            print("      JSX: " .. jsxWin)
        else
            print("R2AE: Windows / AEへのJSX実行に失敗しました")
            print("      JSONは書き出されています。")
            print("      AfterFX: " .. afterfx)
            print("      JSX: " .. jsxWin)
        end
    end
else
    local aeName = find_ae_app_name_mac()
    if not aeName then
        print("After Effectsが見つかりません")
        return
    end
    local cmd = "osascript -e " .. shell_quote("tell application " .. apple_quote(aeName) .. " to activate")
        .. " -e " .. shell_quote("tell application " .. apple_quote(aeName)
        .. " to DoScriptFile POSIX file " .. apple_quote(JSX_PATH))
    local result = os.execute(cmd)
    sent = result == true or result == 0
end

if not IS_WINDOWS then
    if sent then
        print("R2AE: AEに送信しました")
    else
        print("送信に失敗しました。AEが起動しているか確認してください")
    end
end
