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
--   "auto"       : リンク音声は映像レイヤーの音を使う。ズレている場合のみ別レイヤー化
--   "video_only" : Aトラックのうち映像と同一ファイルのものは常に捨てる
--   "separate"   : 常にAトラックを別レイヤーにし、映像側の音声はオフ
local AUDIO_MODE = "auto"

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

local function ensure_dir(path)
    if IS_WINDOWS then
        -- Windowsのmkdirは "/" 区切りを受け付けないため "\" に変換する
        local winPath = path:gsub("/", "\\")
        os.execute('if not exist "' .. winPath .. '" mkdir "' .. winPath .. '"')
    else
        os.execute('mkdir -p "' .. path .. '"')
    end
end

local function json_escape(s)
    if s == nil then return "" end
    s = tostring(s)
    s = s:gsub("\\", "\\\\")
    s = s:gsub('"', '\\"')
    return s
end

-- macOS: /Applications 内の "Adobe After Effects *.app" を新しい順に探す
local function find_ae_app_name_mac()
    local p = io.popen('ls /Applications | grep "^Adobe After Effects" | sort -r')
    local result = p:read("*l")
    p:close()
    if result then return (result:gsub("%.app$", "")) end
    return nil
end

-- Windows: Program Files\Adobe 内の "Adobe After Effects *" フォルダを
-- 新しい順に探し、Support Files\AfterFX.exe が実在するものを返す
local function find_ae_exe_windows()
    local programFiles = os.getenv("PROGRAMFILES") or "C:\\Program Files"
    local adobeDir = programFiles .. "\\Adobe"
    local p = io.popen('cmd /c dir /b /ad "' .. adobeDir .. '" 2^>nul')
    if not p then return nil end

    local candidates = {}
    for line in p:lines() do
        if line:match("^Adobe After Effects") then
            table.insert(candidates, line)
        end
    end
    p:close()

    table.sort(candidates, function(a, b) return a > b end) -- 新しいバージョン優先

    for _, name in ipairs(candidates) do
        local exePath = adobeDir .. "\\" .. name .. "\\Support Files\\AfterFX.exe"
        local f = io.open(exePath, "rb")
        if f then
            f:close()
            return exePath
        end
    end
    return nil
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

local fps = tonumber(project:GetSetting("timelineFrameRate")) or 24

-- タイムライン解像度をコンプサイズに使う
local compW = tonumber(project:GetSetting("timelineResolutionWidth")) or 1920
local compH = tonumber(project:GetSetting("timelineResolutionHeight")) or 1080

-- 送信範囲（IN/OUT）を取得する。rangeOut は排他的（その値のフレームは含まない）
local function get_mark_in_out()
    local ok, mio = pcall(function() return timeline:GetMarkInOut() end)
    if not ok or type(mio) ~= "table" then return nil end

    local r = mio.video or mio.audio
    if not (r and r["in"] and r["out"]) then return nil end

    local tlStart = timeline:GetStartFrame() or 0
    local a, b = r["in"], r["out"]
    -- タイムライン先頭からの相対値で返る場合があるので補正
    if a < tlStart then
        a = a + tlStart
        b = b + tlStart
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
    local srcFps = tonumber(props and props["FPS"])
    local conform = 1
    if srcFps and srcFps > 0 and fps and fps > 0 then
        conform = srcFps / fps
    end

    local sp = used / (dur * conform)

    -- 誤差程度の差は等速とみなす
    if math.abs(sp - 1) < 0.02 then
        return 1, nil
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
        local s = item:GetStart()
        local e = item:GetEnd()
        if s < rangeOut and e > rangeIn then
            if not is_clip_enabled(item) then
                disabledClips = disabledClips + 1
            else
                local mpi = item:GetMediaPoolItem()
                if mpi then
                    local props = mpi:GetClipProperty()
                    local path = props["File Path"]
                    if path and path ~= "" and file_exists(path) then
                        local sourceIn = item:GetLeftOffset() or 0
                        if item.GetSourceStartFrame then
                            local ok, v = pcall(function()
                                return item:GetSourceStartFrame()
                            end)
                            if ok and v then sourceIn = v end
                        end

                        local speed = 1
                        if ENABLE_SPEED and trackType == "video" then
                            local sp, info = get_speed(item, props)
                            speed = sp
                            if info then
                                print(string.format("  [retime] %s : %s",
                                    item:GetName(), info))
                            end
                        end

                        -- 範囲からはみ出した分を切り詰める
                        -- リタイム中は素材側の進み方も倍率に従う
                        local cs = math.max(s, rangeIn)
                        local ce = math.min(e, rangeOut)
                        sourceIn = sourceIn + (cs - s) * speed

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
                            src_w = sw,
                            src_h = sh,
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
    if AUDIO_MODE == "separate" then
        for _, a in ipairs(list) do
            if a.kind == "audio" then
                for _, v in ipairs(list) do
                    if v.kind == "video" and v.path == a.path then
                        v.mute_audio = true
                    end
                end
            end
        end
        return list, 0
    end

    local kept = {}
    local merged = 0
    for _, c in ipairs(list) do
        local drop = false
        if c.kind == "audio" then
            for _, v in ipairs(list) do
                if v.kind == "video" and v.path == c.path then
                    if AUDIO_MODE == "video_only" then
                        drop = true
                    elseif c.start == v.start
                        and c.duration == v.duration
                        and c.source_in == v.source_in then
                        -- 完全にリンクした音声。映像レイヤーの音をそのまま使う
                        drop = true
                    else
                        -- ズレているので独立レイヤーとして残し、映像側を消音
                        v.mute_audio = true
                    end
                end
            end
        end
        if drop then
            merged = merged + 1
        else
            table.insert(kept, c)
        end
    end
    return kept, merged
end

local dedupedList, dupeCount = dedupe_audio(collected)
local finalList, mergedCount = resolve_audio_duplicates(dedupedList)

-- コンプ範囲はマークしたIN/OUTをそのまま使う
local minStart, maxEnd = rangeIn, rangeOut
local totalDuration = maxEnd - minStart

-- ---- JSON書き出し --------------------------------------------------------

ensure_dir(BRIDGE_DIR)

local parts = {}
for _, c in ipairs(finalList) do
    local extra = ""
    if c.src_w and c.src_h then
        extra = extra .. string.format(', "src_w": %d, "src_h": %d', c.src_w, c.src_h)
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
        '"offset": %d, "duration": %d, "source_in": %d, "mute_audio": %s, ' ..
        '"speed": %s%s}',
        json_escape(c.name), json_escape(c.path), c.kind, c.track,
        c.start - minStart, c.duration, c.source_in,
        tostring(c.mute_audio == true), tostring(c.speed or 1), extra
    ))
end

local json = string.format(
[[{
  "comp_name": "%s",
  "width": %d,
  "height": %d,
  "fps": %s,
  "duration": %d,
  "input_scaling": "%s",
  "clips": [
%s
  ]
}]],
    json_escape(timeline:GetName() .. "_AE"),
    compW, compH, tostring(fps), totalDuration, INPUT_SCALING,
    table.concat(parts, ",\n")
)

local f = io.open(JSON_PATH, "w")
f:write(json)
f:close()

print(string.format(
    "範囲: %d - %d / 収集: %d クリップ / 分割音声を統合: %d / " ..
    "リンク音声を統合: %d / スキップ: %d / 無効トラック除外: %d / 無効クリップ除外: %d",
    rangeIn, rangeOut - 1,
    #finalList, dupeCount, mergedCount, skipped, disabledTracks, disabledClips))

-- ---- AE起動 --------------------------------------------------------------

if not file_exists(JSX_PATH) then
    print("r2ae_receive.jsx が見つかりません: " .. JSX_PATH)
    return
end

local sent = false

if IS_WINDOWS then
    local aeExe = find_ae_exe_windows()
    if not aeExe then
        print("After Effectsが見つかりません（Program Files\\Adobe を確認してください）")
        return
    end
    -- Windowsでは AfterFX.exe -r <jsx> で、既存インスタンスがあればそこで
    -- スクリプトが実行され、無ければ新規起動してから実行される。
    -- start "" を挟むことでこのLuaプロセスがAEの終了まで待たされるのを防ぐ。
    local cmd = string.format(
        'start "" "%s" -r "%s"',
        aeExe, JSX_PATH
    )
    sent = os.execute(cmd) and true or false
else
    local aeName = find_ae_app_name_mac()
    if not aeName then
        print("After Effectsが見つかりません")
        return
    end
    local cmd = string.format(
        'osascript -e \'tell application "%s" to activate\' ' ..
        '-e \'tell application "%s" to DoScriptFile POSIX file "%s"\'',
        aeName, aeName, JSX_PATH
    )
    sent = os.execute(cmd) and true or false
end

if sent then
    print("R2AE: AEに送信しました")
else
    print("送信に失敗しました。AEが起動しているか確認してください")
end
