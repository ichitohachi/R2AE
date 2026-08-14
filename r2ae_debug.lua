-- r2ae_debug.lua
-- 再生ヘッド位置のクリップについて、Resolveが返す値をすべてConsoleに出力する
--
-- 置き場所:
--   macOS   : ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/r2ae_debug.lua
--   Windows : %APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\r2ae_debug.lua
--
-- 使い方:
--   1. Workspace > Console を開いておく
--   2. 速度を変更したクリップに再生ヘッドを合わせる
--   3. Workspace > Scripts > Utility > r2ae_debug を実行

if not resolve then
    print("Resolve内から実行してください")
    return
end

local project = resolve:GetProjectManager():GetCurrentProject()
local timeline = project and project:GetCurrentTimeline()
if not timeline then
    print("タイムラインが開かれていません")
    return
end

local item = timeline:GetCurrentVideoItem()
if not item then
    print("再生ヘッドの位置にビデオクリップがありません")
    return
end

local function try(label, fn)
    local ok, v = pcall(fn)
    if ok then
        print(string.format("  %-22s = %s", label, tostring(v)))
    else
        print(string.format("  %-22s = <取得不可>", label))
    end
end

print("========== クリップ情報 ==========")
print("name: " .. tostring(item:GetName()))
print("timelineFrameRate: " ..
    tostring(project:GetSetting("timelineFrameRate")))

print("-- タイムライン上の位置 --")
try("GetStart", function() return item:GetStart() end)
try("GetEnd", function() return item:GetEnd() end)
try("GetDuration", function() return item:GetDuration() end)

print("-- 素材側の範囲 --")
try("GetLeftOffset", function() return item:GetLeftOffset() end)
try("GetRightOffset", function() return item:GetRightOffset() end)
try("GetSourceStartFrame", function() return item:GetSourceStartFrame() end)
try("GetSourceEndFrame", function() return item:GetSourceEndFrame() end)
try("GetSourceStartTime", function() return item:GetSourceStartTime() end)
try("GetSourceEndTime", function() return item:GetSourceEndTime() end)

print("-- メディアプール --")
local mpi = item:GetMediaPoolItem()
if mpi then
    local props = mpi:GetClipProperty()
    for _, k in ipairs({ "File Path", "Resolution", "FPS", "Frames", "Duration" }) do
        print(string.format("  %-22s = %s", k, tostring(props[k])))
    end
else
    print("  メディアプールアイテムなし")
end

print("-- GetProperty() 全ダンプ --")
local ok, p = pcall(function() return item:GetProperty() end)
if ok and type(p) == "table" then
    local keys = {}
    for k in pairs(p) do table.insert(keys, tostring(k)) end
    table.sort(keys)
    for _, k in ipairs(keys) do
        print(string.format("  %-22s = %s", k, tostring(p[k])))
    end
else
    print("  GetProperty() が使えません")
end

print("-- リタイム関連 --")
try("GetIsColorOutputCacheEnabled", function()
    return item:GetIsColorOutputCacheEnabled()
end)
try("GetRetimeCurve", function() return item:GetRetimeCurve() end)

print("==================================")
