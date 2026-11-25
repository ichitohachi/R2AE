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
--   Editページで選択したクリップをAEへ送る（Resolve 21.0.4以降）。
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
--   "separate"   : 常にAトラックを別レイヤーにし、全映像レイヤーの音声はオフ
local AUDIO_MODE = "auto"
-- 同位置でも別チャンネル/意図した重ね録りの可能性があるため、既定では統合しない
local DEDUPE_AUDIO = false
-- インターレースでAPIのfpsがフィールド数を返す場合、実測したフレーム数/秒を指定
local TIMELINE_FRAME_RATE_OVERRIDE = nil

-- 入力スケーリング（"auto" は現在のタイムライン設定を使用）
--   "fit"     : 最長辺をマッチ / 黒帯を挿入（内接フィット）
--   "fill"    : 最短辺をマッチ / 画像を切り抜き（外接フィット）
--   "stretch" : フレームに合わせて引き伸ばし
--   "none"    : 中央に原寸配置
local INPUT_SCALING = "auto"

-- Resolveの回転方向がAEと逆になる場合は -1 にする
-- （実測により既定を -1 にしている）
local ROTATION_SIGN = -1

-- 自動取得したClip Attributesの向きより優先する、素材ごとの追加回転。
-- 90 = 時計回り、-90 = 反時計回り、180 = 半回転、0 = 補正なし。
local SOURCE_ROTATION_BY_PATH = {
    -- ["/path/to/clip.mov"] = 90,
}

-- 速度変更（リタイム）をAEのタイムリマップに反映するか
local ENABLE_SPEED = true

-- macOS: ResolveのFCPXMLからエディットページの変形キーを取得する
local ENABLE_TRANSFORM_KEYFRAMES = true

-- 無効化されたトラックを送信対象から除外するか
local RESPECT_TRACK_ENABLE = true

-- 無効化されたクリップ（Resolveで D を押した状態）を除外するか
local RESPECT_CLIP_ENABLE = true


-- ResolveのAPIがACESバージョンを返さないとき、ACEScctのコールド起動にACES 2.0を使う。
-- ACES 1.xと併用する場合はfalseにする。
local ASSUME_ACES_2_ON_COLD_START = true

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
local colorScience = setting("colorScienceMode")
local acesVersion = tostring(setting("acesVersion") or "")
local isAces = colorScience == "acescc" or colorScience == "acescct"
local projectIDT = setting("colorAcesIDT")
local projectODT = setting("colorAcesODT")

local function clipIDT(props)
    local idt = tostring(props["IDT"] or ""):match("^%s*(.-)%s*$")
    local value = idt:lower()
    if value == "" or value == "project" or value == "project setting"
        or value == "project settings" or value == "use project setting"
        or value == "use project settings" or value == "same as project" then
        return tostring(projectIDT or "")
    end
    return idt
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
if not pixelAspect or pixelAspect <= 0 then
    pixelAspect = 1
    if pixelRaw and pixelRaw ~= "Square" and pixelRaw ~= "square" then
        warn("ピクセル縦横比を解釈できません: " .. tostring(pixelRaw) .. "（正方形として転送）")
    end
end
local inputScaling = INPUT_SCALING
if inputScaling == "auto" then
    local scalingModes = { scaleToFit = "fit", scaleToCrop = "fill", stretch = "stretch", centerCrop = "none" }
    local raw = setting("timelineInputResMismatchBehavior")
    inputScaling = scalingModes[raw] or "fit"
    if raw and not scalingModes[raw] then
        warn("入力スケーリングを解釈できません: " .. tostring(raw) .. "（fitで転送）")
    end
end
if interlaced then
    warn("インターレース: AEのコンポにはフィールド順の設定はありません。素材のフィールド分離と出力時のField Renderingを確認してください")
elseif interlaced == nil then
    warn("タイムラインのインターレース設定をAPIから取得できません。r2ae_debugで確認してください")
end

-- Resolveの選択をトラックごとに分け、AEでのレイヤー順を維持する。
if not timeline.GetSelectedClips then
    print("R2AE: 選択転送にはResolve 21.0.4以降が必要です")
    return
end
local ok, items = pcall(function() return timeline:GetSelectedClips() end)
if not ok or type(items) ~= "table" then
    print("R2AE: タイムラインの選択を取得できませんでした")
    return
end
if #items == 0 then
    print("R2AE: Editページのタイムライン上で送信するクリップを選択してください")
    return
end

local collected = {}
local skipped = 0
local selectedTracks = { audio = {}, video = {} }
for _, item in ipairs(items) do
    local track = item:GetTrackTypeAndIndex()
    local tracks = type(track) == "table" and selectedTracks[track[1]]
    local index = tracks and tonumber(track[2])
    if index and index >= 1 then
        tracks[index] = tracks[index] or {}
        table.insert(tracks[index], item)
    else
        skipped = skipped + 1
    end
end

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
-- Resolveが速度を返さない場合のみ、トリムとソースフレーム範囲から推定する。
local function get_speed(item, srcFps, frames)
    local usedB, reverse = nil, false
    local ok1, ss = pcall(function() return item:GetSourceStartFrame() end)
    local ok2, se = pcall(function() return item:GetSourceEndFrame() end)
    if ok1 and ok2 and ss and se then
        usedB = math.abs(se - ss) + 1
        reverse = (se < ss)
    end

    local ok, options = pcall(function() return item:GetSpeed() end)
    local percentage = ok and type(options) == "table" and tonumber(options.Percentage)
    if percentage and math.abs(percentage) < math.huge then
        if reverse then percentage = -math.abs(percentage) end
        return percentage / 100, nil, true
    end

    if not srcFps then return 1, nil end
    local dur = item:GetDuration()
    if not dur or dur <= 0 then return 1, nil end
    local lo, ro = item:GetLeftOffset(), item:GetRightOffset()
    local usedA = frames and lo and ro and (frames - lo - ro)

    -- 両方取れて食い違う場合は判断できないので等速にする
    if usedA and usedB and math.abs(usedA - usedB) > 1 then
        return 1, string.format("判定不一致 A=%d B=%d dur=%d", usedA, usedB, dur)
    end

    local used = usedA or usedB
    if not used or used <= 0 then return 1, nil end

    -- 素材fpsとタイムラインfpsが異なる場合、Resolveがコンフォームするため
    -- フレーム数の比だけでは速度と区別がつかない。fps比で割り戻す。
    local conform = srcFps / fps

    local sp = used / (dur * conform)

    -- 素材またはタイムラインの1フレーム以内は端点の丸めで生じる。
    if math.abs(used - dur * conform) <= math.max(1, conform) then
        sp = 1
        if not reverse then return 1, nil end
    end
    if reverse then sp = -sp end

    return sp, string.format(
        "used=%d dur=%d srcFps=%s conform=%.4f speed=%.4f",
        used, dur, tostring(srcFps), conform, sp)
end

local function collect_track(trackType, trackIndex)
    local items = selectedTracks[trackType][trackIndex]
    if not items then return end
    if not is_track_enabled(trackType, trackIndex) then
        disabledTracks = disabledTracks + 1
        return
    end
    for _, item in ipairs(items) do
        local s = item:GetStart(true)
        local e = item:GetEnd(true)
        if e > s then
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

                        local srcFps = parse_fps(props["FPS"])
                        local frames = tonumber(props["Frames"])
                        local sourceInTime = nil
                        if trackType == "video" and srcFps and frames and not isSequence then
                            local ok, value = pcall(function() return item:GetSourceStartTime() end)
                            if ok then sourceInTime = tonumber(value) end
                        end

                        local speed, retimeStart, retimeEnd = 1, nil, nil
                        if ENABLE_SPEED then
                            local sp, info, nativeSpeed = get_speed(item, srcFps, frames)
                            speed = sp
                            if not IS_WINDOWS and trackType == "video" and nativeSpeed and speed ~= 1 then
                                if speed < 0 then
                                    local ok, value = pcall(function() return item:GetSourceEndTime() end)
                                    if ok then retimeEnd = tonumber(value) end
                                elseif speed > 0 then
                                    -- 左オフセットは速度変更後のタイムライン基準。小数部を保つ。
                                    local ok, left = pcall(function() return item:GetLeftOffset(true) end)
                                    if ok and type(left) == "number" then retimeStart = left * speed / fps end
                                end
                            end
                            if info then
                                print(string.format("  [retime] %s : %s",
                                    item:GetName(), info))
                                warn(item:GetName() .. ": 速度はAPIフレーム範囲からの推定です。" .. info)
                            end
                        end

                        -- 素材解像度（スケール計算に使う）
                        local sw, sh = nil, nil
                        local resStr = props["Resolution"]
                        if resStr then
                            local a, b = resStr:match("(%d+)x(%d+)")
                            if a then sw, sh = tonumber(a), tonumber(b) end
                        end

                        local mediaID
                        if trackType == "video" and not IS_WINDOWS and mpi.GetMediaId then
                            local ok, id = pcall(function() return mpi:GetMediaId() end)
                            if ok and type(id) == "string" and id ~= "" then mediaID = id end
                        end

                        local sourceField = props["Field Dominance"]
                        if trackType == "video" and (sourceField == nil or sourceField == ""
                            or tostring(sourceField):lower() == "auto") then
                            -- 属性一覧がAutoでも、個別取得では実際のフィールド順を返すことがある。
                            local ok, effective = pcall(function() return mpi:GetClipProperty("Field Dominance") end)
                            if ok and type(effective) == "string" and effective ~= "" then sourceField = effective end
                        end

                        table.insert(collected, {
                            name = item:GetName(),
                            path = path,
                            kind = trackType,
                            media_id = mediaID,
                            track = trackIndex,
                            start = s,
                            duration = e - s,
                            source_in = sourceIn,
                            mute_audio = false,
                            speed = speed,
                            retime_start = retimeStart,
                            retime_end = retimeEnd,
                            src_fps = srcFps,
                            src_frames = frames,
                            source_in_time = sourceInTime,
                            camera_fps = not isSequence and parse_fps(props["Camera FPS"]) or nil,
                            src_fps_raw = tostring(props["FPS"] or ""),
                            src_start_tc = tostring(props["Start TC"] or ""),
                            src_field = tostring(sourceField or ""),
                            src_idt = isAces and clipIDT(props) or nil,
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
        print("R2AE: 選択したクリップに転送可能な映像・音声素材がありません")
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
        if c.kind == "video" then c.mute_audio = true end
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
                        -- コマを合わせる映像キーと、連続した音声の再生を別レイヤーに保つ。
                        if v.retime_keys then
                            if v.variable_speed then
                                warn(v.name .. ": 可変速の音声は平均速度で転送されます（要確認）")
                            end
                        else
                            v.mute_audio = false
                            drop = true
                        end
                        break -- One A item enables only one V instance.
                    end
                end
            end
        end
        if drop then merged = merged + 1 else table.insert(kept, c) end
    end
    return kept, merged
end

local dedupedList, dupeCount = collected, 0
if DEDUPE_AUDIO then dedupedList, dupeCount = dedupe_audio(collected) end
if next(selectedTracks.audio) then
    warn("音量・パン・チャンネル割当・Fairlight処理は未転送です。分割モノ音声はAEでチャンネルを確認してください")
end
-- ResolveのFCPXMLを1回だけ書き出し、選択クリップの変形キーと速度マップを読み取る。
local function read_timeline_keys(clips)
    if IS_WINDOWS or not (ENABLE_TRANSFORM_KEYFRAMES or ENABLE_SPEED)
        or not timeline.Export or not resolve.EXPORT_FCPXML_1_9 then
        return
    end

    local function clip_id(path, offset, duration)
        local startFrame = math.floor(offset + 0.5)
        local frameCount = math.floor(duration + 0.5)
        if math.abs(startFrame - offset) > 0.01 or math.abs(frameCount - duration) > 0.01 then return nil end
        return table.concat({startFrame, frameCount, path}, "|")
    end

    local startFrame = timeline:GetStartFrame()
    local selected = {}
    for _, c in ipairs(clips) do
        if c.kind == "video" then
            local id = clip_id(c.path, c.start - startFrame, c.duration)
            if id then selected[id] = selected[id] == nil and c or false end
        end
    end
    if not next(selected) then return end

    local tempOK, stylePath = pcall(os.tmpname)
    if not tempOK or not stylePath then
        warn("変形キー・速度マップ取得用の一時ファイルを作れません")
        return
    end
    local xmlPath = stylePath .. ".fcpxml"
    local ok, rows = pcall(function()
        local style = assert(io.open(stylePath, "w"))
        local written, writeError = style:write([=[
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="text" encoding="UTF-8"/>
  <xsl:key name="asset" match="resources/asset" use="@id"/>
  <xsl:template name="seconds">
    <xsl:param name="time"/>
    <xsl:variable name="fraction" select="substring-before($time, 's')"/>
    <xsl:choose>
      <xsl:when test="contains($fraction, '/')">
        <xsl:value-of select="number(substring-before($fraction, '/')) div number(substring-after($fraction, '/'))"/>
      </xsl:when>
      <xsl:otherwise><xsl:value-of select="number($fraction)"/></xsl:otherwise>
    </xsl:choose>
  </xsl:template>
  <xsl:template match="/">
    <xsl:for-each select="/fcpxml/library/event/project/sequence">
      <xsl:variable name="tcStart"><xsl:call-template name="seconds"><xsl:with-param name="time" select="@tcStart"/></xsl:call-template></xsl:variable>
      <xsl:text>R2AE&#10;</xsl:text>
      <xsl:apply-templates select="spine/*" mode="clip">
        <xsl:with-param name="parentStart" select="number($tcStart)"/>
      </xsl:apply-templates>
    </xsl:for-each>
  </xsl:template>
  <xsl:template match="asset-clip | clip | ref-clip | mc-clip | sync-clip | gap | spine | video | audio" mode="clip">
    <xsl:param name="parentStart"/>
    <xsl:param name="parentOffset" select="0"/>
    <xsl:variable name="offset"><xsl:call-template name="seconds"><xsl:with-param name="time" select="@offset"/></xsl:call-template></xsl:variable>
    <xsl:variable name="start"><xsl:call-template name="seconds"><xsl:with-param name="time" select="@start"/></xsl:call-template></xsl:variable>
    <xsl:variable name="timelineOffset" select="$parentOffset + number($offset) - $parentStart"/>
    <xsl:variable name="asset" select="key('asset', @ref | video/@ref)"/>
    <xsl:variable name="path" select="$asset/media-rep[@kind='original-media']/@src | $asset/@src"/>
    <xsl:if test="(self::asset-clip or self::clip or self::video) and $asset/@hasVideo = '1' and not(@srcEnable = 'audio') and $path">
      <xsl:variable name="duration"><xsl:call-template name="seconds"><xsl:with-param name="time" select="@duration"/></xsl:call-template></xsl:variable>
      <xsl:value-of select="concat('clip', '&#9;', $timelineOffset, '&#9;', $duration, '&#9;', $path, '&#10;')"/>
      <xsl:if test="timeMap">
        <xsl:variable name="assetStart"><xsl:choose>
          <xsl:when test="$asset/@start"><xsl:call-template name="seconds"><xsl:with-param name="time" select="$asset/@start"/></xsl:call-template></xsl:when>
          <xsl:otherwise>0</xsl:otherwise>
        </xsl:choose></xsl:variable>
        <xsl:value-of select="concat('map', '&#9;', number($start), '&#9;', $assetStart, '&#9;', timeMap/@frameSampling, '&#10;')"/>
        <xsl:for-each select="timeMap/timept">
          <xsl:variable name="time"><xsl:call-template name="seconds"><xsl:with-param name="time" select="@time"/></xsl:call-template></xsl:variable>
          <xsl:variable name="value"><xsl:call-template name="seconds"><xsl:with-param name="time" select="@value"/></xsl:call-template></xsl:variable>
          <xsl:value-of select="concat('time', '&#9;', $time, '&#9;', $value, '&#9;', @interp, '&#10;')"/>
        </xsl:for-each>
      </xsl:if>
      <xsl:if test="not(timeMap or adjust-transform/@enabled = '0' or adjust-transform/@enabled = 'false')">
        <xsl:for-each select="adjust-transform/param[@name='position' or @name='anchor' or @name='rotation' or @name='scale']/keyframeAnimation/keyframe | adjust-blend/param[@name='amount']/keyframeAnimation/keyframe">
          <xsl:variable name="time"><xsl:call-template name="seconds"><xsl:with-param name="time" select="@time"/></xsl:call-template></xsl:variable>
          <xsl:value-of select="concat('key', '&#9;', ../../@name, '&#9;', number($time) - number($start), '&#9;', @value, '&#10;')"/>
        </xsl:for-each>
      </xsl:if>
    </xsl:if>
    <xsl:apply-templates select="(asset-clip | clip | ref-clip | mc-clip | sync-clip | gap | spine | video[@lane] | audio[@lane])[not(../timeMap) or number(@lane) &gt; 0]" mode="clip">
      <xsl:with-param name="parentStart" select="number($start)"/>
      <xsl:with-param name="parentOffset" select="$timelineOffset"/>
    </xsl:apply-templates>
  </xsl:template>
  <xsl:template match="*" mode="clip"/>
</xsl:stylesheet>
]=])
        local closed, closeError = style:close()
        assert(written and closed, writeError or closeError)
        assert(timeline:Export(xmlPath, resolve.EXPORT_FCPXML_1_9, resolve.EXPORT_NONE), "FCPXMLを書き出せません")
        local cmd = "/usr/bin/xsltproc --nonet " .. shell_quote(stylePath) .. " " .. shell_quote(xmlPath)
        local pipe = assert(io.popen(cmd, "r"))
        local result = pipe:read("*a")
        pipe:close()
        assert(result and result:sub(1, 5) == "R2AE\n", "FCPXMLを解釈できません")
        return result
    end)
    os.remove(stylePath)
    os.remove(xmlPath)
    if not ok then
        warn("変形キー・速度マップを取得できませんでした。" .. tostring(rows))
        return
    end

    local function set_retime(c, map)
        local points = map.points
        local seconds = c.duration / fps
        local function fallback(reason)
            warn(c.name .. ": " .. reason .. "。速度は定速として転送します（要確認）")
        end

        if map.sampling ~= "floor" then
            local sampling = map.sampling ~= "" and map.sampling or "不明"
            fallback("Resolveのコマ補間 " .. sampling .. " は未対応")
            return
        end
        if interlaced ~= false or not c.src_fps or (not c.is_sequence and c.src_field:lower() ~= "progressive") then
            fallback("素材fpsまたはフィールド情報によりコマ合わせを適用できません")
            return
        end
        if not map.clip_start or not map.asset_start or #points < 2 or map.unsupported then
            fallback("速度マップの補間を読み取れません")
            return
        end

        -- FCPXMLの定速マップは端点・クリップINの丸めや逆再生時の補正が入る。
        -- 一定速度はResolve APIで得た高精度のトリムと速度を使う。
        local first, last = points[1], points[#points]
        local speed = (last[2] - first[2]) / (last[1] - first[1])
        local sourceStart = c.retime_start
        if c.retime_end then sourceStart = c.retime_end - map.asset_start - 1 / c.src_fps end
        if sourceStart and #points == 2 and math.abs(speed - c.speed) < 0.001 then
            c.retime_keys = {{0, sourceStart}, {seconds, sourceStart + seconds * c.speed}}
            return
        end

        local lastVisibleTime = seconds - 1 / fps
        if first[1] > 1e-6 or last[1] < lastVisibleTime - 1e-6 then
            fallback("速度マップがクリップの表示範囲をカバーしていません")
            return
        end
        local frozen = points[1][2] == points[2][2] and points[2][1] >= lastVisibleTime
        c.variable_speed = #points > 2 and not frozen
        c.retime_keys = points
    end

    local conversions = {
        scale = {1, 1}, position = {compH / 100, compH / 100},
        anchor = {compH / 100, compH / 100}, rotation = {ROTATION_SIGN}, amount = {100},
    }
    local current
    local matches = {}
    for line in rows:gmatch("[^\r\n]+") do
        local record, a, b, value = line:match("^(%a+)\t([^\t]+)\t([^\t]+)\t(.*)$")
        if record == "clip" then
            current = nil
            local urlPath = value:match("^file://(/.*)$") or value:match("^file://localhost(/.*)$")
            local offset, duration = tonumber(a), tonumber(b)
            if urlPath and offset and duration then
                local path = resolve_sequence_path((urlPath:gsub("%%(%x%x)", function(byte)
                    return string.char(tonumber(byte, 16))
                end)))
                local id = clip_id(path, offset * fps, duration * fps)
                if id and selected[id] ~= nil then
                    local candidates = matches[id] or {}
                    current = { animation = {} }
                    candidates[#candidates + 1] = current
                    matches[id] = candidates
                end
            end
        elseif record == "map" and current and ENABLE_SPEED then
            current.map = { clip_start = tonumber(a), asset_start = tonumber(b),
                sampling = value, points = {} }
        elseif record == "time" and current and current.map then
            local map = current.map
            local x, y = tonumber(a), tonumber(b)
            local previous = map.points[#map.points]
            if not x or not y or not map.clip_start or not map.asset_start
                or (value ~= "" and value ~= "linear")
                or (previous and x - map.clip_start <= previous[1]) then
                map.unsupported = true
            else
                map.points[#map.points + 1] = {x - map.clip_start, y - map.asset_start}
            end
        elseif record == "key" and current and ENABLE_TRANSFORM_KEYFRAMES and conversions[a] then
            local keyTime = tonumber(b)
            local x, y = value:match("^(%S+)%s+(%S+)$")
            local factors = conversions[a]
            x, y = tonumber(x or value), tonumber(y)
            if keyTime and x and (#factors == 1 or y) then
                local keys = current.animation[a] or {}
                keys[#keys + 1] = {keyTime, x * factors[1], #factors == 2 and y * factors[2] or nil}
                current.animation[a] = keys
            end
        end
    end
    for id, candidates in pairs(matches) do
        local c = selected[id]
        if c and #candidates == 1 then
            local candidate = candidates[1]
            if next(candidate.animation) then
                for _, keys in pairs(candidate.animation) do
                    table.sort(keys, function(a, b) return a[1] < b[1] end)
                end
                c.transform_keys = candidate.animation
            end
            if candidate.map then set_retime(c, candidate.map) end
        else
            for _, candidate in ipairs(candidates) do
                if next(candidate.animation) or candidate.map then
                    warn("同じ素材・位置・尺のクリップが重なっているため、該当する変形キー・速度マップは転送できません")
                    break
                end
            end
        end
    end
end

read_timeline_keys(dedupedList)

-- Resolve 21.2のBtVideoInfo/RadiometryはProtocol Buffersのワイヤー形式。
-- 19は適用後、27は素材由来の角度。両方とも時計回りを正とするsint32。
local function read_radiometry_rotation(hex)
    if not hex or #hex > 131072 or #hex % 2 ~= 0 or hex:find("[^%x]") then return end
    local bytes = hex:gsub("%x%x", function(pair) return string.char(tonumber(pair, 16)) end)
    local position = 1
    local function read_varint()
        local value, factor = 0, 1
        for _ = 1, 5 do
            local byte = bytes:byte(position)
            if not byte then return end
            position = position + 1
            value = value + (byte % 128) * factor
            if byte < 128 then return value end
            factor = factor * 128
        end
    end
    local angles = {}
    while position <= #bytes do
        local tag = read_varint()
        if not tag or tag < 8 then return end
        local field, wire = math.floor(tag / 8), tag % 8
        if wire == 0 then
            local value = read_varint()
            if value == nil then return end
            if field == 19 or field == 27 then
                local angle = (value % 2 == 0) and value / 2 or -(value + 1) / 2
                if angles[field] or math.abs(angle) > 270 or angle % 90 ~= 0 then return end
                angles[field] = angle
            end
        elseif wire == 2 then
            local length = read_varint()
            if length == nil then return end
            position = position + length
        elseif wire == 1 or wire == 5 then
            position = position + (wire == 1 and 8 or 4)
        else
            return
        end
        if position > #bytes + 1 then return end
    end
    if angles[19] and angles[27] then
        local rotation = (angles[19] - angles[27]) % 360
        return rotation == 270 and -90 or rotation
    end
end

local function bytes_from_hex(hex)
    if not hex or #hex % 2 ~= 0 or hex:find("[^%x]") then return end
    return (hex:gsub("%x%x", function(pair) return string.char(tonumber(pair, 16)) end))
end

local function little_endian_double(bytes, p)
    local high, signByte = bytes:byte(p + 6, p + 7)
    if not signByte then return end
    local exponent = (signByte % 128) * 16 + math.floor(high / 16)
    if exponent == 2047 then return end
    local fraction = high % 16
    for i = p + 5, p, -1 do fraction = fraction * 256 + bytes:byte(i) end
    local sign = signByte < 128 and 1 or -1
    if exponent == 0 then return sign * (fraction / 2^52) * 2^-1022 end
    return sign * (1 + fraction / 2^52) * 2^(exponent - 1023)
end

local function read_protobuf_fields(bytes, visit)
    local p = 1
    local function varint()
        local value, factor = 0, 1
        for _ = 1, 5 do
            local b = bytes:byte(p)
            if not b then return end
            p = p + 1
            value = value + (b % 128) * factor
            if b < 128 then return value end
            factor = factor * 128
        end
    end
    while p <= #bytes do
        local tag = varint()
        if not tag or tag < 8 then return false end
        local wire = tag % 8
        local value
        if wire == 1 then
            value = little_endian_double(bytes, p)
            p = p + 8
        elseif wire == 2 then
            local size = varint()
            if not size or size > #bytes - p + 1 then return false end
            value = bytes:sub(p, p + size - 1)
            p = p + size
        else
            return false
        end
        if value == nil or not visit(math.floor(tag / 8), wire, value) then return false end
    end
    return true
end

-- Resolve 21.2 serializes linear time maps as a Qt property map whose
-- KeyframesBA field contains protobuf data, optionally compressed with Zstandard.
local function time_map_payload(hex)
    local raw = bytes_from_hex(hex)
    if not raw or #raw > 4 * 1024 * 1024 then return end
    local p = 1
    local function uint32()
        local a,b,c,d = raw:byte(p, p + 3)
        if not d then return end
        p = p + 4
        return ((a * 256 + b) * 256 + c) * 256 + d
    end
    local function byte_array()
        local size = uint32()
        if not size or size > #raw - p + 1 then return end
        local value = raw:sub(p, p + size - 1)
        p = p + size
        return value
    end
    if uint32() ~= 1 then return end
    local count = uint32()
    if not count or count > 64 then return end
    for _ = 1, count do
        local key, kind = byte_array(), uint32()
        if not key or raw:byte(p) ~= 0 then return end
        p = p + 1
        if kind == 10 or kind == 12 then
            local data = byte_array()
            if key == "\000K\000e\000y\000f\000r\000a\000m\000e\000s\000B\000A" then
                return kind == 12 and data or nil
            end
        else
            local length = ({[1] = 1, [2] = 4, [4] = 8, [5] = 8, [6] = 8})[kind]
            if not length or p + length - 1 > #raw then return end
            p = p + length
        end
    end
end

local zstd
local function decompress_time_map(bytes)
    if zstd == nil then
        local ok, library = pcall(function()
            local ffi = require("ffi")
            ffi.cdef([[
                unsigned long long ZSTD_getFrameContentSize(const void *src, size_t srcSize);
                size_t ZSTD_decompress(void *dst, size_t capacity, const void *src, size_t srcSize);
            ]])
            local loaded, lib = pcall(ffi.load, "libzstd.1.dylib")
            if not loaded then
                lib = ffi.load("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/libzstd.1.dylib")
            end
            return {ffi = ffi, lib = lib}
        end)
        zstd = ok and library or false
    end
    if not zstd then return end
    local size = tonumber(zstd.lib.ZSTD_getFrameContentSize(bytes, #bytes))
    if not size or size <= 0 or size > 4 * 1024 * 1024 then return end
    local buffer = zstd.ffi.new("char[?]", size)
    if tonumber(zstd.lib.ZSTD_decompress(buffer, size, bytes, #bytes)) ~= size then return end
    return zstd.ffi.string(buffer, size)
end

local function native_time_map(hex)
    local data = time_map_payload(hex)
    if not data then return end
    local mode, bytes = data:byte(1), data:sub(2)
    if mode == 129 then
        bytes = decompress_time_map(bytes)
    elseif mode ~= 128 then
        return
    end
    if not bytes then return end
    local points = {}
    local ok = read_protobuf_fields(bytes, function(field, wire, key)
        if field ~= 1 or wire ~= 2 then return false end
        local x, y = 0, 0
        local linear = read_protobuf_fields(key, function(tag, kind, value)
            if tag == 1 and kind == 1 then x = value; return true end
            if tag == 2 and kind == 1 then y = value; return true end
            return tag == 3 and kind == 2 and not value:find("[^%z]")
        end)
        if not linear or (#points > 0 and x <= points[#points][1]) then return false end
        points[#points + 1] = {x, y}
        return true
    end)
    if ok and #points >= 2 then return points end
end

local function replace_mixed_rate_time_maps(data, selected)
    local function attribute(clip, tag)
        return clip:match("<" .. tag .. ">(.-)</" .. tag .. ">")
    end
    local entities = { amp = "&", lt = "<", gt = ">", quot = '"', apos = "'" }
    local function identity(track, start, duration, path)
        if not start or not duration or not path then return end
        return table.concat({track, start, duration, path}, "|")
    end
    local wanted, records = {}, {}
    for _, c in ipairs(selected) do wanted[identity(c.track, c.start, c.duration, c.path)] = true end
    for video in data:gmatch("<VideoTrackVec>(.-)</VideoTrackVec>") do
        local index = 0
        for track in video:gmatch("<Sm2TiTrack%s[^>]*>(.-)</Sm2TiTrack>") do
            index = index + 1
            for clip in track:gmatch("<Sm2TiVideoClip%s[^>]*>(.-)</Sm2TiVideoClip>") do
                local path = attribute(clip, "MediaFilePath")
                if path then path = resolve_sequence_path((path:gsub("&(%a+);", entities))) end
                local id = identity(index, tonumber(attribute(clip, "Start")),
                    tonumber(attribute(clip, "Duration")), path)
                if id and wanted[id] then records[id] = records[id] == nil and clip or false end
            end
        end
    end
    for _, c in ipairs(selected) do
        local record = records[identity(c.track, c.start, c.duration, c.path)]
        local matched = false
        if record and attribute(record, "MixedFrameRateAlignment") == "0" then
            local hexRate = bytes_from_hex(attribute(record, "MediaFrameRate"))
            local rate = hexRate and little_endian_double(hexRate, 1)
            local rawIn = attribute(record, "In") or "0"
            local whole, hexFraction = rawIn:match("^(%-?%d+)|(%x+)$")
            local fraction = hexFraction and bytes_from_hex(hexFraction)
            local trim = 0
            if hexFraction then trim = fraction and #fraction == 8 and little_endian_double(fraction, 1) end
            local framesIn = tonumber(whole or rawIn)
            local keys = native_time_map(attribute(record, "MediaTimemapBA"))
            if rate and rate > 0 and framesIn and trim and keys then
                local start = (framesIn + trim) / fps
                local endTime = start + (c.duration - 1) / fps
                if keys[1][1] <= start + 1e-6 and keys[#keys][1] >= endTime - 1e-6 then
                    for _, key in ipairs(keys) do
                        key[1] = key[1] - start
                        key[2] = key[2] * rate / c.src_fps
                    end
                    c.retime_keys = keys
                    matched = true
                end
            end
        end
        if not matched then
            warn(c.name .. ": 混在fpsの精密な速度マップを取得できず、FCPXMLの値で近似します（要確認）")
        end
    end
end

local function read_source_rotations(data, selected, clips)
    local found = {}
    for clip in data:gmatch("<Sm2MpVideoClip%s[^>]*>(.-)</Sm2MpVideoClip>") do
        local id = clip:match("<UniqueMediaPoolItemId>([%x%-]+)</UniqueMediaPoolItemId>")
        id = id and id:lower()
        if id and selected[id] then
            local video = clip:match("<Video>%s*<BtVideoInfo[^>]*>(.-)</BtVideoInfo>%s*</Video>")
            local rotation = read_radiometry_rotation(video and video:match("<Radiometry>%s*(%x+)%s*</Radiometry>"))
            if found[id] == nil then
                found[id] = rotation or false
            elseif found[id] ~= rotation then
                found[id] = false
            end
        end
    end
    for _, c in ipairs(clips) do
        if c.kind == "video" and c.media_id then
            c.source_rotation = found[c.media_id:lower()] or nil
        end
    end
end

local function read_drt_metadata(clips)
    if IS_WINDOWS then return end
    local media, retimed = {}, {}
    for _, c in ipairs(clips) do
        if c.kind == "video" and c.media_id and SOURCE_ROTATION_BY_PATH[c.path] == nil then
            media[c.media_id:lower()] = true
        end
        if c.retime_keys and math.abs(c.src_fps - fps) > 1e-6 then
            retimed[#retimed + 1] = c
        end
    end
    if not next(media) and #retimed == 0 then return end
    if not timeline.Export or not resolve.EXPORT_DRT then
        if #retimed > 0 then warn("DRT書き出し非対応のため、混在fpsの速度をFCPXMLの値で近似します（要確認）") end
        return
    end

    local archive
    local ok, err = pcall(function()
        local temporary = os.tmpname()
        archive = temporary .. ".drt"
        os.remove(temporary)
        assert(timeline:Export(archive, resolve.EXPORT_DRT, resolve.EXPORT_NONE), "DRTを書き出せません")
        local function read_member(name)
            local limit = 64 * 1024 * 1024
            local reader = assert(io.popen("/usr/bin/unzip -p " .. shell_quote(archive)
                .. " " .. shell_quote(name) .. " 2>/dev/null", "r"))
            local data = reader:read(limit + 1)
            local closed = reader:close()
            assert(closed and data and #data <= limit, "DRTを読み込めません")
            assert(data:match('DbAppVer="21%.2%.%d+%.%d+"%s+DbPrjVer="17"'),
                "このResolveバージョンのDRT形式は未検証です")
            return data
        end
        if next(media) then
            local read, data = pcall(read_member, "MediaPool/*/MpFolder.xml")
            if read then
                read_source_rotations(data, media, clips)
            else
                warn("DRTから回転を取得できません。" .. tostring(data))
            end
        end
        if #retimed > 0 then
            local read, data = pcall(read_member, "SeqContainer/*.xml")
            if read then
                replace_mixed_rate_time_maps(data, retimed)
            else
                warn("混在fpsの速度をFCPXMLの値で近似します（要確認）。" .. tostring(data))
            end
        end
    end)
    if archive then os.remove(archive) end
    if not ok then warn("DRTから回転または精密な速度マップを取得できません。" .. tostring(err)) end
end

read_drt_metadata(dedupedList)

local finalList, mergedCount = resolve_audio_duplicates(dedupedList)

-- 転送する素材の最初から最後までをコンプ範囲にする。
local minStart, maxEnd = finalList[1].start, finalList[1].start + finalList[1].duration
for _, c in ipairs(finalList) do
    minStart = math.min(minStart, c.start)
    maxEnd = math.max(maxEnd, c.start + c.duration)
end
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
    if c.src_frames and c.src_frames > 0 and c.src_frames < math.huge then
        extra = extra .. string.format(', "src_frames": %s', tostring(c.src_frames))
    end
    if c.source_in_time and c.source_in_time >= 0 and c.source_in_time < math.huge then
        extra = extra .. string.format(', "source_in_time": %.10f', c.source_in_time)
    end
    if c.camera_fps then
        extra = extra .. string.format(', "camera_fps": %s', tostring(c.camera_fps))
    end
    if c.src_idt then
        extra = extra .. string.format(', "src_idt": "%s"', json_escape(c.src_idt))
    end
    local sourceRotation = c.kind == "video" and (SOURCE_ROTATION_BY_PATH[c.path] or c.source_rotation)
    if sourceRotation == 90 or sourceRotation == -90 or sourceRotation == 180 then
        extra = extra .. string.format(', "source_rotation": %d', sourceRotation)
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
    if c.transform_keys then
        local parameters = {}
        for name, keys in pairs(c.transform_keys) do
            local entries = {}
            for _, key in ipairs(keys) do
                entries[#entries + 1] = "[" .. table.concat(key, ",") .. "]"
            end
            parameters[#parameters + 1] = '"' .. name .. '": [' .. table.concat(entries, ",") .. "]"
        end
        extra = extra .. ', "transform_keys": {' .. table.concat(parameters, ",") .. "}"
    end
    if c.retime_keys then
        local entries = {}
        for _, key in ipairs(c.retime_keys) do
            entries[#entries + 1] = string.format("[%.12g,%.12g]", key[1], key[2])
        end
        extra = extra .. ', "retime_keys": [' .. table.concat(entries, ",") .. "]"
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
local colorJSON = ""
if isAces then
    colorJSON = string.format(
        '\n  "aces": {"mode": "%s", "version": "%s", "odt": "%s"},',
        json_escape(colorScience), json_escape(acesVersion), json_escape(tostring(projectODT or ""))
    )
end
local json = string.format(
[[{
  "schema_version": 2,%s
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
    colorJSON,
    json_escape(timeline:GetName() .. "_AE"),
    compW, compH, tostring(compFps), totalDuration / ticksPerFrame, inputScaling,
    tostring(dropFrame), minStart % ticksPerFrame == 0 and tostring(minStart / ticksPerFrame) or "null",
    minStart / fps, tostring(fps), ticksPerFrame, tostring(pixelAspect),
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
    "範囲: %.10g - %.10g (終端は含まない) / 収集: %d クリップ / 分割音声を統合: %d / " ..
    "リンク音声を統合: %d / スキップ: %d / 無効トラック除外: %d / 無効クリップ除外: %d",
    minStart, maxEnd,
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
    local target = "application " .. apple_quote(aeName)
    local receiveFile = "DoScriptFile POSIX file " .. apple_quote(JSX_PATH)
    local version = acesVersion:lower():gsub("^aces[%s_%-]*", "")
    local useStartupTemplate = colorScience == "acescct"
        and (version == "2.0" or (version == "" and ASSUME_ACES_2_ON_COLD_START))
    local script = "tell " .. target .. "\nactivate\n" .. receiveFile .. "\nend tell"
    if useStartupTemplate then
        local receiveCold = "(function(){ $.global.r2aeColdStart = true; " ..
            'try { $.evalFile("' .. json_escape(JSX_PATH) .. '"); } ' ..
            "finally { delete $.global.r2aeColdStart; } }());"
        script = "set alreadyRunning to (" .. target .. " is running)\n" ..
            "tell " .. target .. "\nactivate\nif alreadyRunning then\n" ..
            receiveFile .. "\nelse\nDoScript " .. apple_quote(receiveCold) .. "\nend if\nend tell"
    end
    local cmd = "osascript -e " .. shell_quote("with timeout of 300 seconds\n" .. script .. "\nend timeout")
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
