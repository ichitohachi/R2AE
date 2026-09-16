-- R2AE read-only diagnostic. Run inside Resolve's Workspace > Console (Lua),
-- or install beside r2ae.lua. No timeline/project settings or files are changed.
if not resolve then print("Resolve内から実行してください") return end
local project = resolve:GetProjectManager():GetCurrentProject()
local timeline = project and project:GetCurrentTimeline()
if not timeline then print("タイムラインが開かれていません") return end
local function dump(label, fn)
    local ok, v = pcall(fn)
    print("-- " .. label .. " --")
    if not ok then print("<取得不可> " .. tostring(v)) return end
    local function show(value, prefix, depth)
        if type(value) ~= "table" then print(prefix .. tostring(value)) return end
        if depth > 4 then print(prefix .. "...") return end
        local keys = {}
        for k in pairs(value) do keys[#keys+1] = k end
        table.sort(keys, function(a,b) return tostring(a)<tostring(b) end)
        for _, k in ipairs(keys) do show(value[k], prefix .. tostring(k) .. ": ", depth+1) end
    end
    show(v, "", 0)
end
print("========== R2AE 診断（読み取り専用） ==========")
dump("Resolve version", function() return resolve:GetVersionString() end)
dump("Project settings", function() return project:GetSetting() end)
dump("Timeline settings", function() return timeline:GetSetting() end)
dump("Timeline start TC", function() return timeline:GetStartTimecode() end)
dump("Timeline start frame", function() return timeline:GetStartFrame() end)
dump("Timeline end frame", function() return timeline:GetEndFrame() end)
dump("Timeline IN/OUT", function() return timeline:GetMarkInOut() end)
local item = timeline:GetCurrentVideoItem()
if item then
    dump("Clip name", function() return item:GetName() end)
    dump("Start / End / Duration (subframes)", function()
        return {start=item:GetStart(true),finish=item:GetEnd(true),duration=item:GetDuration(true)}
    end)
    for _, method in ipairs({"GetLeftOffset", "GetRightOffset", "GetSourceStartFrame",
        "GetSourceEndFrame", "GetSourceStartTime", "GetSourceEndTime", "GetProperty"}) do
        dump(method, function() return item[method](item) end)
    end
    local mpi = item:GetMediaPoolItem()
    if mpi then dump("Media pool properties (all)", function() return mpi:GetClipProperty() end) end
else
    print("再生ヘッド位置に映像なし。タイムライン設定だけ出力しました")
end
print("============================================")
